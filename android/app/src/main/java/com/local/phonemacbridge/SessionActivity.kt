package com.local.phonemacbridge

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.GravityCompat
import androidx.lifecycle.lifecycleScope
import com.local.phonemacbridge.databinding.ActivitySessionBinding
import kotlinx.coroutines.launch

class SessionActivity : AppCompatActivity(), FileTreeFragment.FileOpenListener {

    private lateinit var binding: ActivitySessionBinding
    private lateinit var prefs: Prefs
    private var hasLoadError = false
    private lateinit var sessionId: String
    private var sessionName: String = ""
    private var sessionCwd: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySessionBinding.inflate(layoutInflater)
        setContentView(binding.root)

        sessionId   = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        sessionName = intent.getStringExtra(EXTRA_SESSION_NAME).orEmpty()
        sessionCwd  = intent.getStringExtra(EXTRA_SESSION_CWD).orEmpty()

        if (sessionId.isEmpty()) { finish(); return }

        // The user has just opened this exact session. Any pending
        // confirm/done notifications for it are stale — clear them and recount
        // the launcher badge so the red dot keeps reflecting reality.
        NotifyService.clearSessionNotifications(this, sessionId)

        setSupportActionBar(binding.toolbar)
        supportActionBar?.title = sessionName.ifEmpty { getString(R.string.app_name) }
        supportActionBar?.subtitle = friendlySubtitle(sessionCwd)

        binding.toolbar.setNavigationOnClickListener {
            if (binding.drawer.isDrawerOpen(GravityCompat.START)) binding.drawer.closeDrawer(GravityCompat.START)
            else binding.drawer.openDrawer(GravityCompat.START)
        }
        binding.toolbar.setOnClickListener { showRenameDialog() }

        prefs = Prefs(this)
        configureWebView()

        binding.btnRetry.setOnClickListener { loadTerminal() }
        binding.btnOpenSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.drawer.isDrawerOpen(GravityCompat.START)) {
                    binding.drawer.closeDrawer(GravityCompat.START); return
                }
                if (!hasLoadError && binding.webview.canGoBack()) {
                    binding.webview.goBack(); return
                }
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        })

        // Install the file tree fragment in the drawer container.
        if (supportFragmentManager.findFragmentById(R.id.drawerContent) == null) {
            supportFragmentManager.beginTransaction()
                .replace(R.id.drawerContent, FileTreeFragment.newInstance(sessionId))
                .commit()
        }

        loadTerminal()
    }

    private fun friendlySubtitle(cwd: String): String {
        if (cwd.isEmpty()) return ""
        val home = System.getenv("HOME") ?: ""
        return if (home.isNotEmpty() && (cwd == home || cwd.startsWith("$home/"))) "~" + cwd.substring(home.length) else cwd
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val wv = binding.webview
        wv.setBackgroundColor(Color.parseColor("#0B1020"))
        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.loadsImagesAutomatically = true
        s.mediaPlaybackRequiresUserGesture = false
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.textZoom = 100

        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                hasLoadError = false
                binding.errorView.visibility = View.GONE
                binding.progress.visibility = View.VISIBLE
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                binding.progress.visibility = View.GONE
                if (!hasLoadError) binding.webview.visibility = View.VISIBLE
            }
            override fun shouldOverrideUrlLoading(view: WebView?, req: WebResourceRequest?): Boolean {
                val u = req?.url ?: return false
                if (u.scheme == "http" || u.scheme == "https") return false
                return try { startActivity(Intent(Intent.ACTION_VIEW, u)); true } catch (_: Exception) { true }
            }
            override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) {
                if (req?.isForMainFrame != true) return
                hasLoadError = true
                binding.progress.visibility = View.GONE
                binding.webview.visibility = View.GONE
                val detail = err?.description?.toString() ?: ""
                binding.errorText.text = getString(R.string.error_load_failed) +
                    if (detail.isNotEmpty()) "\n\n$detail" else ""
                binding.errorView.visibility = View.VISIBLE
            }
        }
    }

    private fun loadTerminal() {
        val base = prefs.url.trim()
        if (base.isEmpty()) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return
        }
        val url = try { ApiClient(base).terminalUrl(sessionId) }
        catch (e: Exception) {
            binding.errorText.text = "URL 无效: ${e.message}"
            binding.errorView.visibility = View.VISIBLE
            return
        }
        hasLoadError = false
        binding.errorView.visibility = View.GONE
        binding.webview.visibility = View.VISIBLE
        binding.webview.loadUrl(url)
    }

    private fun showRenameDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(sessionName)
            setSelection(sessionName.length)
        }
        val pad = (resources.displayMetrics.density * 20).toInt()
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.action_rename)
            .setView(wrap)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val newName = input.text.toString().trim()
                if (newName.isEmpty() || newName == sessionName) return@setPositiveButton
                lifecycleScope.launch {
                    try {
                        val updated = ApiClient(prefs.url).renameSession(sessionId, newName)
                        sessionName = updated.name
                        supportActionBar?.title = sessionName
                    } catch (e: Exception) {
                        Toast.makeText(this@SessionActivity, "改名失败: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }.show()
    }

    override fun onPause() {
        super.onPause()
        // Pause JS timers / media but keep the WebSocket open if the OS allows.
        binding.webview.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.webview.onResume()
        // Ask the page to reconnect immediately instead of waiting for the
        // exponential backoff. `window.__reconnectNow` is exposed by app.js.
        binding.webview.evaluateJavascript(
            "window.__reconnectNow && window.__reconnectNow();",
            null
        )
    }

    override fun onDestroy() {
        // Release the WebView fully so it isn't holding network sockets after
        // the Activity is gone (and so reopening gets a clean slate).
        try { binding.webview.stopLoading() } catch (_: Exception) {}
        try { (binding.webview.parent as? android.view.ViewGroup)?.removeView(binding.webview) } catch (_: Exception) {}
        try { binding.webview.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }

    // FileTreeFragment.FileOpenListener
    override fun onFileOpen(sessionId: String, relPath: String, entry: FsEntry) {
        binding.drawer.closeDrawer(GravityCompat.START)
        startActivity(Intent(this, FileViewerActivity::class.java).apply {
            putExtra(FileViewerActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(FileViewerActivity.EXTRA_REL_PATH, relPath)
            putExtra(FileViewerActivity.EXTRA_KIND, entry.kind)
            putExtra(FileViewerActivity.EXTRA_SIZE, entry.size)
        })
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.session_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_reload  -> { binding.webview.reload(); true }
            R.id.action_files   -> {
                if (binding.drawer.isDrawerOpen(GravityCompat.START))
                    binding.drawer.closeDrawer(GravityCompat.START)
                else binding.drawer.openDrawer(GravityCompat.START)
                true
            }
            R.id.action_rename -> { showRenameDialog(); true }
            R.id.action_settings -> { startActivity(Intent(this, SettingsActivity::class.java)); true }
            else -> super.onOptionsItemSelected(item)
        }
    }

    companion object {
        const val EXTRA_SESSION_ID   = "session_id"
        const val EXTRA_SESSION_NAME = "session_name"
        const val EXTRA_SESSION_CWD  = "session_cwd"
    }
}
