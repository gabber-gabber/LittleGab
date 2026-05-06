package com.local.phonemacbridge

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.tabs.TabLayout
import com.local.phonemacbridge.databinding.ActivityListBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class ConversationListActivity : AppCompatActivity() {

    private lateinit var binding: ActivityListBinding
    private lateinit var prefs: Prefs
    private lateinit var adapter: ConversationAdapter
    private var refreshJob: Job? = null
    private var lastError: String? = null
    private var currentProvider: String = "claude"

    private val newSessionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode != RESULT_OK) return@registerForActivityResult
            val id = result.data?.getStringExtra(NewSessionActivity.RESULT_SESSION_ID) ?: return@registerForActivityResult
            val name = result.data?.getStringExtra(NewSessionActivity.RESULT_SESSION_NAME).orEmpty()
            val cwd = result.data?.getStringExtra(NewSessionActivity.RESULT_SESSION_CWD).orEmpty()
            // Open the session directly
            startActivity(Intent(this, SessionActivity::class.java).apply {
                putExtra(SessionActivity.EXTRA_SESSION_ID, id)
                putExtra(SessionActivity.EXTRA_SESSION_NAME, name)
                putExtra(SessionActivity.EXTRA_SESSION_CWD, cwd)
            })
            refresh(force = false)
        }

    private val notifPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) maybeStartNotifyService()
            else toast("未授予通知权限,无法在锁屏上弹会话事件。设置里可以重新开。")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityListBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.title = getString(R.string.app_name)

        prefs = Prefs(this)
        currentProvider = prefs.agentProvider

        adapter = ConversationAdapter(
            onClick = { s -> openSession(s) },
            onLongClick = { s, anchor -> showItemMenu(s, anchor) },
        )
        binding.recycler.layoutManager = LinearLayoutManager(this)
        binding.recycler.adapter = adapter

        binding.swipe.setOnRefreshListener { refresh(force = true) }
        binding.fab.setOnClickListener { openNewSessionActivity() }
        binding.emptyBtnSettings.setOnClickListener { openSettings() }
        setupProviderTabs()

        requestNotifPermIfNeeded()
    }

    private fun setupProviderTabs() {
        binding.providerTabs.getTabAt(if (currentProvider == "codex") 1 else 0)?.select()
        binding.providerTabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                val next = if (tab.position == 1) "codex" else "claude"
                if (next == currentProvider) return
                currentProvider = next
                prefs.agentProvider = next
                adapter.submitList(emptyList())
                binding.empty.visibility = View.GONE
                refresh(force = true)
            }
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) { refresh(force = true) }
        })
    }

    private fun providerLabel(provider: String = currentProvider): String =
        if (provider == "codex") getString(R.string.provider_codex) else getString(R.string.provider_claude)

    private fun requestNotifPermIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            maybeStartNotifyService(); return
        }
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) maybeStartNotifyService()
        else notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun maybeStartNotifyService() {
        val p = Prefs(this)
        if (p.notificationsEnabled && p.url.isNotBlank()) NotifyService.start(this)
    }

    override fun onStart() {
        super.onStart()
        if (prefs.url.isBlank()) { openSettings(); return }
        startAutoRefresh()
        // The Activity's request-permission flow can be missed (user dismisses
        // the prompt, or it never shows on some OEM ROMs). On every visible
        // re-entry, double-check that the OS will actually surface our
        // notifications — both the app-level "show notifications" toggle and
        // the high-importance event channel can be off independently.
        if (prefs.notificationsEnabled) maybeWarnAboutBlockedNotifications()
    }

    private fun maybeWarnAboutBlockedNotifications() {
        val nm = NotificationManagerCompat.from(this)
        val appAllowed = nm.areNotificationsEnabled()
        val channelOn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val sys = getSystemService(NotificationManager::class.java)
            val ch = sys?.getNotificationChannel(NotifyService.CHANNEL_EVENT)
            ch != null && ch.importance != NotificationManager.IMPORTANCE_NONE
        } else true
        if (appAllowed && channelOn) return

        val msg = when {
            !appAllowed -> "应用通知被系统关闭了。任务完成 / y/n 提醒不会出现在锁屏。点「去开启」跳到系统设置。"
            !channelOn -> "「会话事件」通知渠道被关闭了。这正是任务完成 / y/n 走的渠道,需要手动打开。"
            else -> return
        }
        AlertDialog.Builder(this)
            .setTitle("通知没法弹出")
            .setMessage(msg)
            .setNegativeButton("先不", null)
            .setPositiveButton("去开启") { _, _ -> openAppNotificationSettings() }
            .show()
    }

    private fun openAppNotificationSettings() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                )
            } else {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", packageName, null))
                )
            }
        } catch (e: Exception) { toast("打开系统设置失败:${e.message}") }
    }

    override fun onStop() {
        super.onStop()
        refreshJob?.cancel()
    }

    private fun startAutoRefresh() {
        refreshJob?.cancel()
        refreshJob = lifecycleScope.launch {
            refresh(force = false)
            while (isActive) {
                delay(3000)
                refresh(force = false)
            }
        }
    }

    private fun refresh(force: Boolean) {
        val base = prefs.url.trim()
        if (base.isEmpty()) return
        if (force) binding.swipe.isRefreshing = true

        lifecycleScope.launch {
            try {
                val list = ApiClient(base).listSessions()
                val visible = list.filter { it.provider == currentProvider }
                adapter.submitList(visible)
                // Reclaim phone-side cache for any session the server has dropped.
                SessionCache.reconcile(this@ConversationListActivity, list.map { it.id }.toSet())
                binding.empty.visibility = if (visible.isEmpty()) View.VISIBLE else View.GONE
                binding.emptyText.text = getString(R.string.empty_hint_agent, providerLabel())
                binding.emptyBtnSettings.visibility = View.GONE
                lastError = null
                binding.swipe.isRefreshing = false
            } catch (e: Exception) {
                val msg = e.message ?: e.javaClass.simpleName
                if (msg != lastError) {
                    lastError = msg
                    binding.empty.visibility = View.VISIBLE
                    binding.emptyText.text = getString(R.string.list_error, msg)
                    binding.emptyBtnSettings.visibility = View.VISIBLE
                    adapter.submitList(emptyList())
                }
                binding.swipe.isRefreshing = false
            }
        }
    }

    private fun openNewSessionActivity() {
        val base = prefs.url.trim()
        if (base.isEmpty()) { openSettings(); return }
        newSessionLauncher.launch(Intent(this, NewSessionActivity::class.java).apply {
            putExtra(NewSessionActivity.EXTRA_PROVIDER, currentProvider)
        })
    }

    private fun showItemMenu(s: SessionInfo, anchor: View) {
        val pm = PopupMenu(this, anchor)
        pm.menu.add(0, 1, 0, R.string.action_rename)
        if (s.tmuxName.isNotEmpty()) {
            pm.menu.add(0, 3, 1, R.string.action_open_mac)
        }
        pm.menu.add(0, 2, 2, R.string.action_delete)
        pm.setOnMenuItemClickListener { mi ->
            when (mi.itemId) {
                1 -> { askForName(current = s.name, title = R.string.action_rename) { name ->
                    lifecycleScope.launch {
                        try {
                            ApiClient(prefs.url).renameSession(s.id, name)
                            refresh(force = false)
                        } catch (e: Exception) { toast("改名失败: ${e.message}") }
                    }
                }; true }
                2 -> { confirmDelete(s); true }
                3 -> { openOnMac(s); true }
                else -> false
            }
        }
        pm.show()
    }

    private fun openOnMac(s: SessionInfo) {
        lifecycleScope.launch {
            try {
                ApiClient(prefs.url).openMacTerminal(s.id)
                toast("Mac 终端已打开: " + s.name)
            } catch (e: Exception) { toast("打开 Mac 终端失败: " + e.message) }
        }
    }

    private fun confirmDelete(s: SessionInfo) {
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_title)
            .setMessage(getString(R.string.delete_msg, s.name))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.action_delete) { _, _ ->
                lifecycleScope.launch {
                    try {
                        ApiClient(prefs.url).deleteSession(s.id)
                        // Wipe any cached files this session touched on the phone.
                        SessionCache.clearSession(this@ConversationListActivity, s.id)
                        refresh(force = false)
                    } catch (e: Exception) { toast("删除失败: ${e.message}") }
                }
            }.show()
    }

    private fun askForName(current: String, title: Int, onOk: (String) -> Unit) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(current)
            setSelection(current.length)
        }
        val pad = (resources.displayMetrics.density * 20).toInt()
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(wrap)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ -> onOk(input.text.toString().trim()) }
            .show()
    }

    private fun openSession(s: SessionInfo) {
        startActivity(Intent(this, SessionActivity::class.java).apply {
            putExtra(SessionActivity.EXTRA_SESSION_ID, s.id)
            putExtra(SessionActivity.EXTRA_SESSION_NAME, s.name)
            putExtra(SessionActivity.EXTRA_SESSION_CWD, s.cwd)
        })
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    private fun toast(msg: String) { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.list_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_settings -> { openSettings(); true }
            R.id.action_refresh -> { refresh(force = true); true }
            else -> super.onOptionsItemSelected(item)
        }
    }
}
