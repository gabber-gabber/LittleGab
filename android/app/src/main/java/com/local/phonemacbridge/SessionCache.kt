package com.local.phonemacbridge

import android.content.Context
import java.io.File
import java.io.FileOutputStream

/**
 * Per-session scratch directory for files the user opened via FileViewerActivity
 * (PDF external opens, "open externally" on binaries).  Scoped by session id so
 * deleting a session can wipe its files immediately.
 *
 * Layout:  cacheDir/shared/<sessionId>/<filename>
 */
object SessionCache {
    private const val ROOT = "shared"
    private const val HIGH_BYTES = 100L * 1024 * 1024
    private const val LOW_BYTES  =  50L * 1024 * 1024

    fun dirFor(ctx: Context, sessionId: String): File {
        val safe = sessionId.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "_" }
        val d = File(ctx.cacheDir, "$ROOT/$safe")
        d.mkdirs()
        return d
    }

    fun writeFile(ctx: Context, sessionId: String, name: String, bytes: ByteArray): File {
        val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "download" }
        val out = File(dirFor(ctx, sessionId), safeName)
        FileOutputStream(out).use { it.write(bytes) }
        trimIfNeeded(ctx)
        return out
    }

    /** Nuke one session's cache directory (called right after deleting the session). */
    fun clearSession(ctx: Context, sessionId: String) {
        dirFor(ctx, sessionId).deleteRecursively()
    }

    /**
     * Remove cache directories whose session id is NOT in [liveIds].
     * Call this after refreshing the session list to reclaim space from
     * sessions the server has already reaped.
     */
    fun reconcile(ctx: Context, liveIds: Set<String>) {
        val root = File(ctx.cacheDir, ROOT)
        if (!root.isDirectory) return
        root.listFiles()?.forEach { d ->
            if (d.isDirectory && d.name !in liveIds) d.deleteRecursively()
        }
    }

    /** Global trim when total across all sessions exceeds HIGH, drop oldest first. */
    fun trimIfNeeded(ctx: Context) {
        val root = File(ctx.cacheDir, ROOT)
        if (!root.isDirectory) return
        val files = root.walkTopDown().filter { it.isFile }.toMutableList()
        var total = files.sumOf { it.length() }
        if (total <= HIGH_BYTES) return
        files.sortBy { it.lastModified() }
        for (f in files) {
            if (total <= LOW_BYTES) break
            val len = f.length()
            if (f.delete()) total -= len
        }
    }
}
