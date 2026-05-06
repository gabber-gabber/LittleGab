package com.local.phonemacbridge

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.local.phonemacbridge.databinding.ActivityFolderPickerBinding
import kotlinx.coroutines.launch

/**
 * Browses the Mac filesystem (via /api/browse) so the user can pick a session cwd.
 * Result intent extras:
 *   EXTRA_SELECTED_PATH - absolute path string
 */
class FolderPickerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityFolderPickerBinding
    private lateinit var prefs: Prefs
    private lateinit var adapter: EntryAdapter
    private var currentPath: String = ""
    private var homePath: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityFolderPickerBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        binding.toolbar.setNavigationOnClickListener { finish() }

        prefs = Prefs(this)

        adapter = EntryAdapter { entry ->
            if (entry.isDir) navigate(joinPath(currentPath, entry.name))
        }
        binding.recycler.layoutManager = LinearLayoutManager(this)
        binding.recycler.adapter = adapter

        binding.btnUp.setOnClickListener { goUp() }
        binding.btnHome.setOnClickListener { navigate("~") }
        binding.btnSelect.setOnClickListener {
            val data = Intent().putExtra(EXTRA_SELECTED_PATH, currentPath)
            setResult(RESULT_OK, data)
            finish()
        }

        val start = intent.getStringExtra(EXTRA_START_PATH) ?: "~"
        navigate(start)
    }

    private fun navigate(path: String) {
        binding.progress.visibility = View.VISIBLE
        binding.errorText.visibility = View.GONE
        val base = prefs.url.trim()
        if (base.isEmpty()) {
            binding.progress.visibility = View.GONE
            binding.errorText.visibility = View.VISIBLE
            binding.errorText.text = "未设置服务器 URL"
            return
        }
        lifecycleScope.launch {
            try {
                val result = ApiClient(base).browse(path)
                currentPath = result.path
                homePath = result.home
                binding.currentPath.text = friendlyPath(currentPath)
                adapter.submitList(result.entries)
                binding.empty.visibility = if (result.entries.isEmpty()) View.VISIBLE else View.GONE
                binding.btnUp.isEnabled = result.parent != null
                binding.progress.visibility = View.GONE
            } catch (e: Exception) {
                binding.progress.visibility = View.GONE
                binding.errorText.visibility = View.VISIBLE
                binding.errorText.text = "加载失败: ${e.message}"
            }
        }
    }

    private fun goUp() {
        if (currentPath == "/" || currentPath.isEmpty()) return
        val parent = currentPath.substringBeforeLast('/', "")
        navigate(if (parent.isEmpty()) "/" else parent)
    }

    private fun friendlyPath(p: String): String {
        if (homePath.isNotEmpty() && (p == homePath || p.startsWith("$homePath/"))) {
            return "~" + p.substring(homePath.length)
        }
        return p
    }

    private fun joinPath(base: String, child: String): String {
        if (base.endsWith("/")) return base + child
        return "$base/$child"
    }

    private class EntryAdapter(private val onClick: (FsEntry) -> Unit)
        : ListAdapter<FsEntry, VH>(DIFF) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_folder_entry, parent, false)
            return VH(v)
        }
        override fun onBindViewHolder(h: VH, position: Int) {
            val e = getItem(position)
            h.icon.text = if (e.isDir) "📁" else "📄"
            h.name.text = e.name
            h.meta.text = if (e.isDir) "目录" else humanSize(e.size)
            h.itemView.alpha = if (e.isDir) 1.0f else 0.5f
            h.itemView.isEnabled = e.isDir
            h.itemView.setOnClickListener { if (e.isDir) onClick(e) }
        }
        companion object {
            val DIFF = object : DiffUtil.ItemCallback<FsEntry>() {
                override fun areItemsTheSame(a: FsEntry, b: FsEntry) = a.name == b.name && a.isDir == b.isDir
                override fun areContentsTheSame(a: FsEntry, b: FsEntry) = a == b
            }
        }
    }

    private class VH(v: View) : RecyclerView.ViewHolder(v) {
        val icon: TextView = v.findViewById(R.id.fp_icon)
        val name: TextView = v.findViewById(R.id.fp_name)
        val meta: TextView = v.findViewById(R.id.fp_meta)
    }

    companion object {
        const val EXTRA_START_PATH = "start_path"
        const val EXTRA_SELECTED_PATH = "selected_path"

        fun humanSize(bytes: Long): String {
            if (bytes < 1024) return "${bytes} B"
            val kb = bytes / 1024.0
            if (kb < 1024) return "%.1f KB".format(kb)
            val mb = kb / 1024.0
            if (mb < 1024) return "%.1f MB".format(mb)
            return "%.2f GB".format(mb / 1024.0)
        }
    }
}
