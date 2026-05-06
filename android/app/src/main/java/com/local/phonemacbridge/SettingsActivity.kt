package com.local.phonemacbridge

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.local.phonemacbridge.databinding.ActivitySettingsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import android.widget.CompoundButton

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private lateinit var prefs: Prefs

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents == null) {
            android.widget.Toast.makeText(this, R.string.scan_cancelled, android.widget.Toast.LENGTH_SHORT).show()
            return@registerForActivityResult
        }
        binding.urlInput.setText(result.contents)
        binding.urlInput.setSelection(result.contents.length)
        // Immediately probe the scanned URL.
        doTest()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        binding.toolbar.setNavigationOnClickListener { finish() }

        prefs = Prefs(this)
        binding.urlInput.setText(prefs.url)

        binding.notifToggle.isChecked = prefs.notificationsEnabled
        binding.notifToggle.setOnCheckedChangeListener(
            CompoundButton.OnCheckedChangeListener { _, checked ->
                prefs.notificationsEnabled = checked
                if (checked && prefs.url.isNotBlank()) NotifyService.start(this)
                else NotifyService.stop(this)
            }
        )

        binding.btnTest.setOnClickListener { doTest() }
        binding.btnSave.setOnClickListener { doSave() }
        binding.btnScan.setOnClickListener {
            scanLauncher.launch(ScanOptions().apply {
                setPrompt(getString(R.string.scan_prompt))
                setBeepEnabled(false)
                setOrientationLocked(false)
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            })
        }
    }

    private fun currentUrl(): String = binding.urlInput.text?.toString()?.trim().orEmpty()

    private fun validate(url: String): String? {
        if (url.isEmpty()) return getString(R.string.error_no_url)
        if (!url.startsWith("http://") && !url.startsWith("https://")) return getString(R.string.url_invalid)
        return null
    }

    private fun doTest() {
        val url = currentUrl()
        val err = validate(url)
        if (err != null) { binding.testResult.text = err; return }

        binding.testResult.text = getString(R.string.test_running)
        binding.btnTest.isEnabled = false
        lifecycleScope.launch {
            val (ok, ms, msg) = probe(url)
            binding.btnTest.isEnabled = true
            binding.testResult.text = if (ok) getString(R.string.test_ok, ms) else getString(R.string.test_fail, msg)
        }
    }

    private fun doSave() {
        val url = currentUrl()
        val err = validate(url)
        if (err != null) { binding.testResult.text = err; return }
        prefs.url = url
        if (prefs.notificationsEnabled) NotifyService.start(this)
        Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
        finish()
    }

    private data class ProbeResult(val ok: Boolean, val ms: Int, val msg: String)

    private suspend fun probe(base: String): ProbeResult = withContext(Dispatchers.IO) {
        val healthUrl = try {
            val u = URL(base)
            URL(u.protocol, u.host, u.port, "/healthz")
        } catch (e: Exception) {
            return@withContext ProbeResult(false, 0, "URL 解析失败: ${e.message}")
        }
        val start = System.currentTimeMillis()
        var conn: HttpURLConnection? = null
        try {
            conn = (healthUrl.openConnection() as HttpURLConnection).apply {
                connectTimeout = 3000
                readTimeout = 3000
                requestMethod = "GET"
            }
            val code = conn.responseCode
            val body = conn.inputStream.bufferedReader().use { it.readText().trim() }
            val ms = (System.currentTimeMillis() - start).toInt()
            if (code == 200 && body == "ok") ProbeResult(true, ms, "")
            else ProbeResult(false, ms, "HTTP $code, body=$body")
        } catch (e: Exception) {
            ProbeResult(false, 0, e.javaClass.simpleName + ": " + (e.message ?: ""))
        } finally {
            conn?.disconnect()
        }
    }
}
