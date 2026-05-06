package com.local.phonemacbridge

data class SessionInfo(
    val id: String,
    val name: String,
    val provider: String = "claude",
    val cwd: String = "",
    val autorun: String = "",
    val createdAt: Long,
    val lastActivityAt: Long,
    val cols: Int = 80,
    val rows: Int = 24,
    val clientCount: Int = 0,
    val alive: Boolean = true,
    val preview: String = "",
    val tmuxName: String = "",
    val macAttachCommand: String = "",
)

data class FsEntry(
    val name: String,
    val isDir: Boolean,
    val isSymlink: Boolean = false,
    val size: Long = 0,
    val mtime: Long = 0,
    val ext: String = "",
    val mime: String = "",
    val kind: String = "" // "dir" | "text" | "image" | "pdf" | "binary"
)

data class BrowseResult(
    val path: String,
    val parent: String?,
    val home: String,
    val entries: List<FsEntry>,
    val truncated: Boolean,
)

data class FsListResult(
    val cwd: String,
    val path: String,        // relative to cwd
    val absPath: String,
    val entries: List<FsEntry>,
    val truncated: Boolean,
)

data class FileReadResult(
    val bytes: ByteArray,
    val kind: String,   // "text" | "image" | "pdf" | "binary"
    val mime: String,
    val size: Long,
    val mtime: Long,
) {
    fun asText(): String = String(bytes, Charsets.UTF_8)
}

data class AgentHistorySession(
    val id: String,
    val provider: String = "claude",
    val cwd: String,
    val firstPrompt: String,
    val threadName: String = "",
    val messageCount: Int,
    val lastModified: Long,
    val size: Long,
    val gitBranch: String = "",
    val projectDir: String = "",
)
