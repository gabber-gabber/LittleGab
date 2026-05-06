package com.local.phonemacbridge

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.local.phonemacbridge.databinding.ActivityFileViewerBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Dispatches by file kind:
 *   text     - ScrollView + EditText (monospace); Save menu writes via /api/fs/write
 *   text/md  - additional "render" toggle that switches to WebView with marked.min.js
 *   image    - ImageView with decoded bitmap
 *   pdf      - opens via external Intent.ACTION_VIEW (copied to cache + FileProvider URI)
 *   binary   - "Open external" button
 */
class FileViewerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityFileViewerBinding
    private lateinit var prefs: Prefs
    private lateinit var sessionId: String
    private lateinit var relPath: String
    private var hintedKind: String = ""
    private var hintedSize: Long = 0

    private var fileKind: String = ""
    private var fileMime: String = ""
    private var originalText: String? = null
    private var isMarkdownRendering: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityFileViewerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        sessionId    = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        relPath      = intent.getStringExtra(EXTRA_REL_PATH).orEmpty()
        hintedKind   = intent.getStringExtra(EXTRA_KIND).orEmpty()
        hintedSize   = intent.getLongExtra(EXTRA_SIZE, 0L)

        prefs = Prefs(this)

        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        binding.toolbar.setNavigationOnClickListener { finish() }
        val nameOnly = relPath.substringAfterLast('/')
        supportActionBar?.title = nameOnly
        supportActionBar?.subtitle = relPath

        binding.genericBtnOpen.setOnClickListener { openExternal() }

        loadFile()
    }

    private fun loadFile() {
        val base = prefs.url.trim()
        if (base.isEmpty()) { finish(); return }
        hideAll()
        binding.fvProgress.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val result = ApiClient(base).fsRead(sessionId, relPath)
                fileKind = result.kind
                fileMime = result.mime
                binding.fvProgress.visibility = View.GONE
                render(result)
            } catch (e: Exception) {
                binding.fvProgress.visibility = View.GONE
                binding.fvError.text = "加载失败: ${e.message}"
                binding.fvError.visibility = View.VISIBLE
            }
            invalidateOptionsMenu()
        }
    }

    private fun hideAll() {
        binding.fvError.visibility = View.GONE
        binding.textScroll.visibility = View.GONE
        binding.imageView.visibility = View.GONE
        binding.mdWebView.visibility = View.GONE
        binding.genericView.visibility = View.GONE
    }

    private fun render(r: FileReadResult) {
        when (r.kind) {
            "text" -> renderText(r.asText())
            "image" -> renderImage(r.bytes)
            "pdf" -> renderPdfStub(r.bytes, r.mime)
            else -> renderGeneric(r.bytes, r.mime)
        }
    }

    private fun renderText(text: String) {
        originalText = text
        binding.textEditor.setText(text)
        binding.textScroll.visibility = View.VISIBLE
        isMarkdownRendering = false
    }

    private fun renderImage(bytes: ByteArray) {
        try {
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bmp == null) throw RuntimeException("decode failed")
            binding.imageView.setImageBitmap(bmp)
            binding.imageView.visibility = View.VISIBLE
        } catch (e: Exception) {
            binding.fvError.text = "图片解码失败: ${e.message}"
            binding.fvError.visibility = View.VISIBLE
        }
    }

    private fun renderPdfStub(bytes: ByteArray, mime: String) {
        // Write to cache and immediately hand off to an external PDF viewer.
        val file = writeToCache(bytes, relPath.substringAfterLast('/'))
        openFileExternally(file, mime)
        // Also show the "generic" fallback in case no viewer is installed.
        binding.genericIcon.text = "📕"
        binding.genericText.text = getString(R.string.pdf_opening_external)
        binding.genericView.visibility = View.VISIBLE
    }

    private fun renderGeneric(bytes: ByteArray, mime: String) {
        binding.genericIcon.text = "📦"
        binding.genericText.text = getString(R.string.unsupported_kind, mime, bytes.size)
        binding.genericView.visibility = View.VISIBLE
    }

    private fun writeToCache(bytes: ByteArray, name: String): File =
        SessionCache.writeFile(this, sessionId, name, bytes)

    private fun openFileExternally(file: File, mime: String) {
        val uri: Uri = try {
            FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        } catch (_: Exception) {
            Uri.fromFile(file)
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            startActivity(Intent.createChooser(intent, null))
        } catch (e: Exception) {
            Toast.makeText(this, "没有可用应用: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openExternal() {
        // re-read and re-open externally (re-uses a session-relative path)
        val base = prefs.url.trim()
        lifecycleScope.launch {
            try {
                val r = ApiClient(base).fsRead(sessionId, relPath)
                val file = writeToCache(r.bytes, relPath.substringAfterLast('/'))
                openFileExternally(file, r.mime.ifEmpty { fileMime })
            } catch (e: Exception) {
                Toast.makeText(this@FileViewerActivity, "失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun save() {
        val current = binding.textEditor.text?.toString() ?: return
        val base = prefs.url.trim()
        if (base.isEmpty()) return
        lifecycleScope.launch {
            try {
                val (size, _) = ApiClient(base).fsWrite(sessionId, relPath, current)
                originalText = current
                Toast.makeText(this@FileViewerActivity, "已保存 ($size 字节)", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@FileViewerActivity, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun toggleMarkdown() {
        if (isMarkdownRendering) {
            // switch back to source
            binding.mdWebView.visibility = View.GONE
            binding.textScroll.visibility = View.VISIBLE
            isMarkdownRendering = false
            invalidateOptionsMenu()
            return
        }
        val source = binding.textEditor.text?.toString() ?: originalText ?: ""
        val html = buildMarkdownHtml(source)
        binding.mdWebView.settings.javaScriptEnabled = true
        binding.mdWebView.setBackgroundColor(0xFF0B1020.toInt())
        binding.mdWebView.loadDataWithBaseURL(
            prefs.url.trim().let {
                // base URL so the rendered page can pull /vendor/marked.min.js from the Mac
                try { val u = java.net.URL(it); "${u.protocol}://${u.host}${if (u.port == -1) "" else ":${u.port}"}/" } catch (_: Exception) { null }
            },
            html, "text/html", "utf-8", null
        )
        binding.textScroll.visibility = View.GONE
        binding.mdWebView.visibility = View.VISIBLE
        isMarkdownRendering = true
        invalidateOptionsMenu()
    }

    private fun buildMarkdownHtml(source: String): String {
        val encoded = Base64.encodeToString(source.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        // Renderer is loaded from the Mac bridge's /vendor/marked.min.js (see server/web).
        return """
            <!doctype html>
            <html><head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              html,body { background:#0b1020; color:#d7e3ff; margin:0; padding:16px;
                font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; font-size:15px; line-height:1.55; }
              h1,h2,h3,h4 { color:#ffffff; margin:1.2em 0 .5em; }
              a { color:#4f8cff; }
              code { background:#000; padding:2px 5px; border-radius:3px; font-family:ui-monospace,Menlo,monospace; font-size:13px; }
              pre code { display:block; padding:12px; overflow:auto; }
              blockquote { border-left:3px solid #4f8cff; margin:0; padding:4px 12px; color:#b5c2e0; background:#131936; }
              table { border-collapse:collapse; margin:1em 0; }
              th,td { border:1px solid #2a3870; padding:6px 10px; }
              img { max-width:100%; }
              hr { border:none; border-top:1px solid #2a3870; }
            </style></head><body>
            <div id="out">渲染中…</div>
            <script src="/vendor/marked.min.js"></script>
            <script>
              (function() {
                var src = atob("$encoded");
                // decode UTF-8 (atob gives latin-1 bytes)
                try { src = decodeURIComponent(escape(src)); } catch(e) {}
                if (typeof marked === "undefined") {
                  document.getElementById("out").textContent = "marked.js 未加载,Mac 服务需要包含 /vendor/marked.min.js";
                  return;
                }
                document.getElementById("out").innerHTML = marked.parse(src);
              })();
            </script>
            </body></html>
        """.trimIndent()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.file_viewer_menu, menu)
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        val canSave = fileKind == "text" && !isMarkdownRendering
        menu.findItem(R.id.fv_save)?.isVisible = canSave
        menu.findItem(R.id.fv_md_toggle)?.apply {
            val isMd = isMarkdownFile()
            isVisible = fileKind == "text" && isMd
            setTitle(if (isMarkdownRendering) R.string.md_source else R.string.md_render)
        }
        menu.findItem(R.id.fv_external)?.isVisible = fileKind != "text"
        menu.findItem(R.id.fv_reload)?.isVisible = true
        return super.onPrepareOptionsMenu(menu)
    }

    private fun isMarkdownFile(): Boolean {
        val lower = relPath.lowercase()
        return lower.endsWith(".md") || lower.endsWith(".markdown")
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.fv_save -> { save(); true }
            R.id.fv_md_toggle -> { toggleMarkdown(); true }
            R.id.fv_reload -> { loadFile(); true }
            R.id.fv_external -> { openExternal(); true }
            else -> super.onOptionsItemSelected(item)
        }
    }

    companion object {
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_REL_PATH   = "rel_path"
        const val EXTRA_KIND       = "kind"
        const val EXTRA_SIZE       = "size"
    }
}
