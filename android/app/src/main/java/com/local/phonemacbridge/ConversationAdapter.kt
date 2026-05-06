package com.local.phonemacbridge

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ConversationAdapter(
    private val onClick: (SessionInfo) -> Unit,
    private val onLongClick: (SessionInfo, View) -> Unit,
) : ListAdapter<SessionInfo, ConversationAdapter.VH>(DIFF) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_conversation, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val s = getItem(position)
        holder.name.text = s.name
        holder.preview.text = if (s.preview.isNotEmpty()) s.preview
            else holder.itemView.context.getString(R.string.preview_empty)
        holder.time.text = formatTime(s.lastActivityAt)
        holder.badge.visibility = if (s.clientCount > 0) View.VISIBLE else View.GONE
        holder.itemView.setOnClickListener { onClick(s) }
        holder.itemView.setOnLongClickListener { v -> onLongClick(s, v); true }
    }

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val name: TextView = v.findViewById(R.id.itemName)
        val preview: TextView = v.findViewById(R.id.itemPreview)
        val time: TextView = v.findViewById(R.id.itemTime)
        val badge: View = v.findViewById(R.id.itemBadge)
    }

    companion object {
        private val TIME_FORMAT_HM = SimpleDateFormat("HH:mm", Locale.getDefault())
        private val TIME_FORMAT_DATE = SimpleDateFormat("M/d", Locale.getDefault())

        private fun formatTime(ms: Long): String {
            if (ms <= 0) return ""
            val d = Date(ms)
            val now = System.currentTimeMillis()
            val diffHours = (now - ms) / 3_600_000L
            return when {
                diffHours < 24 -> TIME_FORMAT_HM.format(d)
                diffHours < 24 * 7 -> TIME_FORMAT_DATE.format(d)
                else -> TIME_FORMAT_DATE.format(d)
            }
        }

        val DIFF = object : DiffUtil.ItemCallback<SessionInfo>() {
            override fun areItemsTheSame(a: SessionInfo, b: SessionInfo) = a.id == b.id
            override fun areContentsTheSame(a: SessionInfo, b: SessionInfo) = a == b
        }
    }
}
