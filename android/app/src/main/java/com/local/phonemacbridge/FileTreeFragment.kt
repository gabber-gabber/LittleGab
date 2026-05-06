package com.local.phonemacbridge

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.local.phonemacbridge.databinding.FragmentFileTreeBinding
import kotlinx.coroutines.launch

/**
 * Lists files under a session's cwd. Directory navigation stays inside the session.
 * Tapping a file notifies the hosting Activity via FileOpenListener.
 * Long-pressing an entry opens delete menu. Plus-button creates a file or folder.
 */
class FileTreeFragment : Fragment() {

    interface FileOpenListener {
        fun onFileOpen(sessionId: String, relPath: String, entry: FsEntry)
    }

    private var _binding: FragmentFileTreeBinding? = null
    private val binding get() = _binding!!

    private lateinit var prefs: Prefs
    private lateinit var sessionId: String
    private var currentPath: String = "."
    private lateinit var adapter: TreeAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionId = requireArguments().getString(ARG_SESSION_ID) ?: ""
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, saved: Bundle?): View {
        _binding = FragmentFileTreeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        prefs = Prefs(requireContext())
        adapter = TreeAdapter(
            onClick = { e -> onEntryTap(e) },
            onLongClick = { e, anchor -> showEntryMenu(e, anchor) },
        )
        binding.ftRecycler.layoutManager = LinearLayoutManager(requireContext())
        binding.ftRecycler.adapter = adapter

        binding.ftUp.setOnClickListener { goUp() }
        binding.ftRoot.setOnClickListener { navigate(".") }
        binding.ftRefresh.setOnClickListener { navigate(currentPath) }
        binding.ftNew.setOnClickListener { showCreateMenu(it) }

        navigate(".")
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    fun refresh() { if (_binding != null) navigate(currentPath) }

    private fun onEntryTap(e: FsEntry) {
        if (e.isDir) {
            val child = if (currentPath == "." || currentPath.isEmpty()) e.name else "$currentPath/${e.name}"
            navigate(child)
        } else {
            val rel = if (currentPath == "." || currentPath.isEmpty()) e.name else "$currentPath/${e.name}"
            (activity as? FileOpenListener)?.onFileOpen(sessionId, rel, e)
        }
    }

    private fun showCreateMenu(anchor: View) {
        val pm = PopupMenu(requireContext(), anchor)
        pm.menu.add(0, 1, 0, getString(R.string.create_file))
        pm.menu.add(0, 2, 1, getString(R.string.create_folder))
        pm.setOnMenuItemClickListener { mi ->
            when (mi.itemId) {
                1 -> { askForName(getString(R.string.create_file), "") { name -> createFile(name) }; true }
                2 -> { askForName(getString(R.string.create_folder), "") { name -> createFolder(name) }; true }
                else -> false
            }
        }
        pm.show()
    }

    private fun showEntryMenu(e: FsEntry, anchor: View) {
        val pm = PopupMenu(requireContext(), anchor)
        pm.menu.add(0, 1, 0, getString(R.string.action_delete))
        pm.setOnMenuItemClickListener { mi ->
            when (mi.itemId) {
                1 -> { confirmDelete(e); true }
                else -> false
            }
        }
        pm.show()
    }

    private fun createFile(name: String) {
        if (name.isBlank()) return
        val rel = joinRel(currentPath, name)
        lifecycleScope.launch {
            try {
                ApiClient(prefs.url).fsTouch(sessionId, rel)
                navigate(currentPath)
            } catch (e: Exception) { toast("创建失败: ${e.message}") }
        }
    }

    private fun createFolder(name: String) {
        if (name.isBlank()) return
        val rel = joinRel(currentPath, name)
        lifecycleScope.launch {
            try {
                ApiClient(prefs.url).fsMkdir(sessionId, rel)
                navigate(currentPath)
            } catch (e: Exception) { toast("创建失败: ${e.message}") }
        }
    }

    private fun confirmDelete(e: FsEntry) {
        val rel = joinRel(currentPath, e.name)
        val msg = if (e.isDir) getString(R.string.confirm_delete_dir, e.name)
                  else getString(R.string.confirm_delete_file, e.name)
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.action_delete)
            .setMessage(msg)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.action_delete) { _, _ ->
                lifecycleScope.launch {
                    try {
                        ApiClient(prefs.url).fsDelete(sessionId, rel, recursive = e.isDir)
                        navigate(currentPath)
                    } catch (ex: Exception) { toast("删除失败: ${ex.message}") }
                }
            }.show()
    }

    private fun askForName(title: String, current: String, onOk: (String) -> Unit) {
        val input = EditText(requireContext()).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(current)
            setSelection(current.length)
        }
        val pad = (resources.displayMetrics.density * 20).toInt()
        val wrap = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(requireContext())
            .setTitle(title)
            .setView(wrap)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ -> onOk(input.text.toString().trim()) }
            .show()
    }

    private fun joinRel(base: String, name: String): String =
        if (base == "." || base.isEmpty()) name else "$base/$name"

    private fun toast(msg: String) {
        if (_binding == null) return
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    private fun goUp() {
        if (currentPath == "." || currentPath.isEmpty()) return
        val parent = currentPath.substringBeforeLast('/', "")
        navigate(if (parent.isEmpty()) "." else parent)
    }

    private fun navigate(path: String) {
        val base = prefs.url.trim()
        if (base.isEmpty()) return
        binding.ftProgress.visibility = View.VISIBLE
        binding.ftError.visibility = View.GONE
        lifecycleScope.launch {
            try {
                val res = ApiClient(base).fsList(sessionId, path)
                currentPath = res.path
                binding.ftPath.text = res.path
                binding.ftUp.isEnabled = res.path != "." && res.path.isNotEmpty()
                adapter.submitList(res.entries)
                binding.ftProgress.visibility = View.GONE
            } catch (e: Exception) {
                binding.ftProgress.visibility = View.GONE
                binding.ftError.text = "加载失败: ${e.message}"
                binding.ftError.visibility = View.VISIBLE
            }
        }
    }

    private class TreeAdapter(
        private val onClick: (FsEntry) -> Unit,
        private val onLongClick: (FsEntry, View) -> Unit,
    ) : ListAdapter<FsEntry, VH>(DIFF) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_file_entry, parent, false)
            return VH(v)
        }
        override fun onBindViewHolder(h: VH, position: Int) {
            val e = getItem(position)
            h.icon.text = iconFor(e)
            h.name.text = e.name
            h.meta.text = if (e.isDir) "" else FolderPickerActivity.humanSize(e.size)
            h.itemView.setOnClickListener { onClick(e) }
            h.itemView.setOnLongClickListener { v -> onLongClick(e, v); true }
        }
        companion object {
            val DIFF = object : DiffUtil.ItemCallback<FsEntry>() {
                override fun areItemsTheSame(a: FsEntry, b: FsEntry) = a.name == b.name && a.isDir == b.isDir
                override fun areContentsTheSame(a: FsEntry, b: FsEntry) = a == b
            }
            fun iconFor(e: FsEntry): String {
                if (e.isDir) return "📁"
                return when (e.kind) {
                    "image" -> "🖼"
                    "pdf" -> "📕"
                    "text" -> "📄"
                    else -> "📦"
                }
            }
        }
    }

    private class VH(v: View) : RecyclerView.ViewHolder(v) {
        val icon: TextView = v.findViewById(R.id.fe_icon)
        val name: TextView = v.findViewById(R.id.fe_name)
        val meta: TextView = v.findViewById(R.id.fe_meta)
    }

    companion object {
        private const val ARG_SESSION_ID = "session_id"
        fun newInstance(sessionId: String): FileTreeFragment = FileTreeFragment().apply {
            arguments = Bundle().apply { putString(ARG_SESSION_ID, sessionId) }
        }
    }
}
