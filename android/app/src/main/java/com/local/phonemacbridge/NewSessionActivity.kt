package com.local.phonemacbridge

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.tabs.TabLayout
import com.local.phonemacbridge.databinding.ActivityNewSessionBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class NewSessionActivity : AppCompatActivity() {

    private lateinit var binding: ActivityNewSessionBinding
    private lateinit var prefs: Prefs
    private var provider: String = "claude"

    private lateinit var modes: List<AgentMode>

    private lateinit var historyAdapter: HistoryAdapter
    private var searchJob: Job? = null

    private val folderPickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode != RESULT_OK) return@registerForActivityResult
            val path = result.data?.getStringExtra(FolderPickerActivity.EXTRA_SELECTED_PATH) ?: return@registerForActivityResult
            binding.nsCwd.setText(path)
            binding.nsCwd.setSelection(path.length)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityNewSessionBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        binding.toolbar.setNavigationOnClickListener { finish() }

        prefs = Prefs(this)
        provider = normalizeProvider(intent.getStringExtra(EXTRA_PROVIDER) ?: prefs.agentProvider)
        prefs.agentProvider = provider
        modes = modesFor(provider)
        supportActionBar?.title = getString(R.string.new_conv_title_agent, providerLabel())
        binding.nsAutorun.text = getString(R.string.nc_autorun_agent, commandName())
        binding.nsModeHint.text = getString(R.string.nc_mode_hint_agent, providerLabel())
        binding.nsSearch.hint = getString(R.string.nc_search_hint_agent, providerLabel())

        // Mode spinner
        binding.nsMode.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            modes.map { it.label })
        binding.nsMode.setSelection(0)

        // Default cwd — previous session or home
        binding.nsCwd.setText("~")
        binding.nsPick.setOnClickListener {
            folderPickerLauncher.launch(
                Intent(this, FolderPickerActivity::class.java)
                    .putExtra(FolderPickerActivity.EXTRA_START_PATH, binding.nsCwd.text?.toString()?.ifBlank { "~" })
            )
        }

        // History list
        historyAdapter = HistoryAdapter { s -> onPickHistory(s) }
        binding.nsHistRecycler.layoutManager = LinearLayoutManager(this)
        binding.nsHistRecycler.adapter = historyAdapter

        binding.nsSearch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                searchJob?.cancel()
                searchJob = lifecycleScope.launch {
                    delay(250) // debounce
                    reloadHistory()
                }
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        // Tabs
        binding.nsTabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) { switchTab(tab.position) }
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) {}
        })

        binding.nsBtnCreate.setOnClickListener { createNewSession() }

        switchTab(0)
    }

    private fun switchTab(position: Int) {
        if (position == 0) {
            binding.nsNewPane.visibility = View.VISIBLE
            binding.nsHistoryPane.visibility = View.GONE
            binding.nsBtnCreate.visibility = View.VISIBLE
        } else {
            binding.nsNewPane.visibility = View.GONE
            binding.nsHistoryPane.visibility = View.VISIBLE
            binding.nsBtnCreate.visibility = View.GONE
            if (historyAdapter.itemCount == 0) reloadHistory()
        }
    }

    private fun reloadHistory() {
        val base = prefs.url.trim()
        if (base.isEmpty()) return
        binding.nsHistError.visibility = View.GONE
        binding.nsHistProgress.visibility = View.VISIBLE
        val q = binding.nsSearch.text?.toString()?.trim().orEmpty()
        lifecycleScope.launch {
            try {
                val sessions = ApiClient(base).listAgentSessions(provider, if (q.isEmpty()) null else q)
                historyAdapter.submitList(sessions)
                binding.nsHistProgress.visibility = View.GONE
                binding.nsHistMeta.text = if (q.isEmpty())
                    getString(R.string.nc_hist_summary, sessions.size)
                else
                    getString(R.string.nc_hist_filtered, sessions.size, sessions.size)
                if (sessions.isEmpty()) {
                    binding.nsHistError.visibility = View.VISIBLE
                    binding.nsHistError.text = getString(R.string.nc_hist_empty)
                }
            } catch (e: Exception) {
                binding.nsHistProgress.visibility = View.GONE
                binding.nsHistError.visibility = View.VISIBLE
                binding.nsHistError.text = getString(R.string.nc_hist_error, e.message ?: "")
            }
        }
    }

    private fun createNewSession() {
        val base = prefs.url.trim()
        if (base.isEmpty()) { toast("未设置 URL"); return }
        val name = binding.nsName.text?.toString()?.trim().orEmpty()
        val cwd  = binding.nsCwd.text?.toString()?.trim().orEmpty().ifEmpty { "~" }
        val modeId = modes[binding.nsMode.selectedItemPosition].id
        val autorun = if (binding.nsAutorun.isChecked) buildAutorun(modeId) else ""

        createSessionAndOpen(name, cwd, autorun)
    }

    private fun onPickHistory(cs: AgentHistorySession) {
        val base = prefs.url.trim()
        if (base.isEmpty()) { toast("未设置 URL"); return }
        val label = cs.firstPrompt.ifEmpty { cs.threadName }
        val name = if (label.isNotEmpty()) label.take(30) else "历史 ${cs.id.take(6)}"
        val cwd  = cs.cwd.ifBlank { "~" }
        val autorun = if (provider == "codex") "codex --no-alt-screen resume ${cs.id}" else "claude --resume ${cs.id}"
        createSessionAndOpen(name, cwd, autorun)
    }

    private fun createSessionAndOpen(name: String, cwd: String, autorun: String) {
        binding.nsBtnCreate.isEnabled = false
        lifecycleScope.launch {
            try {
                val s = ApiClient(prefs.url).createSession(
                    name = name.ifBlank { null },
                    cwd = cwd.ifBlank { null },
                    autorun = autorun.ifBlank { null },
                    provider = provider,
                )
                val data = Intent().apply {
                    putExtra(RESULT_SESSION_ID, s.id)
                    putExtra(RESULT_SESSION_NAME, s.name)
                    putExtra(RESULT_SESSION_CWD, s.cwd)
                }
                setResult(Activity.RESULT_OK, data)
                finish()
            } catch (e: Exception) {
                binding.nsBtnCreate.isEnabled = true
                toast("创建失败: ${e.message}")
            }
        }
    }

    private fun toast(msg: String) { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    private fun providerLabel(): String =
        if (provider == "codex") getString(R.string.provider_codex) else getString(R.string.provider_claude)

    private fun commandName(): String = if (provider == "codex") "codex" else "claude"

    private fun buildAutorun(modeId: String): String {
        if (provider == "codex") {
            return when (modeId) {
                "fullAuto" -> "codex --no-alt-screen --full-auto"
                "readOnly" -> "codex --no-alt-screen --sandbox read-only"
                "bypassPermissions" -> "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox"
                else -> "codex --no-alt-screen"
            }
        }
        return if (modeId == "default") "claude" else "claude --permission-mode $modeId"
    }

    private fun modesFor(provider: String): List<AgentMode> =
        if (provider == "codex") {
            listOf(
                AgentMode("default", "默认(正常交互,按需确认)"),
                AgentMode("fullAuto", "Full Auto(可写工作区,按需确认)"),
                AgentMode("readOnly", "只读沙盒"),
                AgentMode("bypassPermissions", "旁路权限(完全自动,危险)"),
            )
        } else {
            listOf(
                AgentMode("default", "默认(正常编辑,逐条确认)"),
                AgentMode("acceptEdits", "自动接受编辑"),
                AgentMode("plan", "计划模式(只规划不改)"),
                AgentMode("bypassPermissions", "旁路权限(完全自动,危险)"),
            )
        }

    private fun normalizeProvider(raw: String?): String =
        if (raw?.trim()?.lowercase() == "codex") "codex" else "claude"

    data class AgentMode(val id: String, val label: String)

    private class HistoryAdapter(val onClick: (AgentHistorySession) -> Unit)
        : ListAdapter<AgentHistorySession, HistoryVH>(DIFF) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): HistoryVH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_claude_session, parent, false)
            return HistoryVH(v)
        }
        override fun onBindViewHolder(h: HistoryVH, position: Int) {
            val s = getItem(position)
            h.prompt.text = s.firstPrompt.ifBlank { "(无首轮提问)" }
            h.cwd.text    = friendly(s.cwd)
            h.meta.text   = "${s.messageCount} 条 · ${s.id.take(8)}${if (s.gitBranch.isNotEmpty()) " · ${s.gitBranch}" else ""}"
            h.time.text   = formatTime(s.lastModified)
            h.itemView.setOnClickListener { onClick(s) }
        }
        companion object {
            val DIFF = object : DiffUtil.ItemCallback<AgentHistorySession>() {
                override fun areItemsTheSame(a: AgentHistorySession, b: AgentHistorySession) = a.id == b.id && a.provider == b.provider
                override fun areContentsTheSame(a: AgentHistorySession, b: AgentHistorySession) = a == b
            }
            private val DAY = SimpleDateFormat("M/d HH:mm", Locale.getDefault())
            private val HM  = SimpleDateFormat("HH:mm", Locale.getDefault())
            private val HOME = System.getenv("HOME") ?: ""
            fun friendly(p: String): String =
                if (HOME.isNotEmpty() && (p == HOME || p.startsWith("$HOME/"))) "~" + p.substring(HOME.length) else p
            fun formatTime(ms: Long): String {
                if (ms <= 0) return ""
                val diffHours = (System.currentTimeMillis() - ms) / 3_600_000L
                return if (diffHours < 24) HM.format(Date(ms)) else DAY.format(Date(ms))
            }
        }
    }

    private class HistoryVH(v: View) : RecyclerView.ViewHolder(v) {
        val prompt: TextView = v.findViewById(R.id.cs_prompt)
        val cwd: TextView = v.findViewById(R.id.cs_cwd)
        val meta: TextView = v.findViewById(R.id.cs_meta)
        val time: TextView = v.findViewById(R.id.cs_time)
    }

    companion object {
        const val RESULT_SESSION_ID = "session_id"
        const val RESULT_SESSION_NAME = "session_name"
        const val RESULT_SESSION_CWD = "session_cwd"
        const val EXTRA_PROVIDER = "provider"
    }
}
