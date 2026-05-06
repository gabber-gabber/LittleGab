package com.local.phonemacbridge

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Tiny HTTP client for the bridge server.
 * The saved URL is a full URL potentially with `?token=...` baked in (from QR);
 * we split it into base + token here.
 */
class ApiClient(private val baseUrlWithToken: String) {

    val baseUrl: String
    val token: String

    init {
        val u = URL(baseUrlWithToken)
        val portPart = if (u.port == -1) "" else ":${u.port}"
        baseUrl = "${u.protocol}://${u.host}$portPart"
        token = parseQueryParam(u.query, "token") ?: ""
    }

    /** Build the URL the WebView should load for a given session. */
    fun terminalUrl(sessionId: String?): String {
        val u = URL(baseUrlWithToken)
        val portPart = if (u.port == -1) "" else ":${u.port}"
        val params = LinkedHashMap<String, String>()
        u.query?.split("&")?.forEach { pair ->
            val idx = pair.indexOf('=')
            if (idx > 0) params[pair.substring(0, idx)] = pair.substring(idx + 1)
        }
        if (!sessionId.isNullOrEmpty()) params["session"] = URLEncoder.encode(sessionId, "UTF-8")
        val qs = params.entries.joinToString("&") { "${it.key}=${it.value}" }
        return "${u.protocol}://${u.host}$portPart${u.path.ifEmpty { "/" }}${if (qs.isNotEmpty()) "?$qs" else ""}"
    }

    // ------- sessions -------

    suspend fun listSessions(): List<SessionInfo> = withContext(Dispatchers.IO) {
        val resp = textRequest("GET", "/api/sessions", null)
        val arr = JSONObject(resp).optJSONArray("sessions") ?: JSONArray()
        (0 until arr.length()).map { parseSession(arr.getJSONObject(it)) }
    }

    suspend fun createSession(
        name: String?,
        cwd: String?,
        autorun: String?,
    ): SessionInfo = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            if (!name.isNullOrBlank()) put("name", name)
            if (!cwd.isNullOrBlank()) put("cwd", cwd)
            if (!autorun.isNullOrBlank()) put("autorun", autorun)
        }
        val resp = textRequest("POST", "/api/sessions", body.toString())
        parseSession(JSONObject(resp))
    }

    suspend fun renameSession(id: String, name: String): SessionInfo = withContext(Dispatchers.IO) {
        val body = JSONObject().put("name", name).toString()
        val resp = textRequest("PATCH", "/api/sessions/$id", body)
        parseSession(JSONObject(resp))
    }

    suspend fun deleteSession(id: String): Boolean = withContext(Dispatchers.IO) {
        val resp = textRequest("DELETE", "/api/sessions/$id", null)
        JSONObject(resp).optBoolean("ok", false)
    }

    /** Ask the server to open Terminal.app on the Mac attached to this session's tmux pane. */
    suspend fun openMacTerminal(id: String): String = withContext(Dispatchers.IO) {
        val resp = textRequest("POST", "/api/sessions/$id/open-mac-terminal", "")
        JSONObject(resp).optString("macAttachCommand", "")
    }

    suspend fun ping(): Boolean = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("GET", "/healthz", false, null)
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty().trim()
            conn.disconnect()
            code == 200 && body == "ok"
        } catch (_: Exception) { false }
    }

    // ------- filesystem -------

    suspend fun browse(path: String?, hidden: Boolean = false): BrowseResult = withContext(Dispatchers.IO) {
        val qs = buildString {
            if (!path.isNullOrEmpty()) { append("path="); append(URLEncoder.encode(path, "UTF-8")) }
            if (hidden) { if (isNotEmpty()) append("&"); append("hidden=1") }
        }
        val p = if (qs.isEmpty()) "/api/browse" else "/api/browse?$qs"
        val resp = textRequest("GET", p, null)
        val o = JSONObject(resp)
        BrowseResult(
            path = o.getString("path"),
            parent = o.optString("parent", "").ifEmpty { null },
            home = o.optString("home", ""),
            entries = parseEntries(o.getJSONArray("entries")),
            truncated = o.optBoolean("truncated", false),
        )
    }

    suspend fun fsList(sessionId: String, path: String, hidden: Boolean = false): FsListResult = withContext(Dispatchers.IO) {
        val qs = buildString {
            append("session="); append(URLEncoder.encode(sessionId, "UTF-8"))
            append("&path="); append(URLEncoder.encode(path, "UTF-8"))
            if (hidden) append("&hidden=1")
        }
        val resp = textRequest("GET", "/api/fs/list?$qs", null)
        val o = JSONObject(resp)
        FsListResult(
            cwd = o.getString("cwd"),
            path = o.optString("path", "."),
            absPath = o.optString("absPath", ""),
            entries = parseEntries(o.getJSONArray("entries")),
            truncated = o.optBoolean("truncated", false),
        )
    }

    suspend fun fsRead(sessionId: String, path: String): FileReadResult = withContext(Dispatchers.IO) {
        val qs = "session=${URLEncoder.encode(sessionId, "UTF-8")}&path=${URLEncoder.encode(path, "UTF-8")}"
        val conn = openConnection("GET", "/api/fs/read?$qs", true, null)
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                val body = conn.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                throw RuntimeException("HTTP $code: $body")
            }
            val kind = conn.getHeaderField("X-File-Kind") ?: "binary"
            val mime = conn.contentType ?: "application/octet-stream"
            val size = conn.getHeaderField("X-File-Size")?.toLongOrNull() ?: 0
            val mtime = conn.getHeaderField("X-File-Mtime")?.toLongOrNull() ?: 0
            val bout = ByteArrayOutputStream()
            conn.inputStream.use { it.copyTo(bout) }
            FileReadResult(bytes = bout.toByteArray(), kind = kind, mime = mime, size = size, mtime = mtime)
        } finally { conn.disconnect() }
    }

    suspend fun fsMkdir(sessionId: String, path: String): Boolean = withContext(Dispatchers.IO) {
        val qs = "session=${URLEncoder.encode(sessionId, "UTF-8")}&path=${URLEncoder.encode(path, "UTF-8")}"
        val resp = textRequest("POST", "/api/fs/mkdir?$qs", "")
        JSONObject(resp).optBoolean("ok", false)
    }

    suspend fun fsTouch(sessionId: String, path: String): Boolean = withContext(Dispatchers.IO) {
        val qs = "session=${URLEncoder.encode(sessionId, "UTF-8")}&path=${URLEncoder.encode(path, "UTF-8")}"
        val resp = textRequest("POST", "/api/fs/touch?$qs", "")
        JSONObject(resp).optBoolean("ok", false)
    }

    suspend fun fsDelete(sessionId: String, path: String, recursive: Boolean = false): Boolean = withContext(Dispatchers.IO) {
        val qs = StringBuilder()
            .append("session=").append(URLEncoder.encode(sessionId, "UTF-8"))
            .append("&path=").append(URLEncoder.encode(path, "UTF-8"))
            .apply { if (recursive) append("&recursive=1") }
            .toString()
        val resp = textRequest("DELETE", "/api/fs/delete?$qs", null)
        JSONObject(resp).optBoolean("ok", false)
    }

    suspend fun fsWrite(sessionId: String, path: String, content: String): Pair<Long, Long> = withContext(Dispatchers.IO) {
        val qs = "session=${URLEncoder.encode(sessionId, "UTF-8")}&path=${URLEncoder.encode(path, "UTF-8")}"
        val conn = openConnection("PUT", "/api/fs/write?$qs", true, "text/plain; charset=utf-8")
        try {
            conn.doOutput = true
            conn.outputStream.use { it.write(content.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw RuntimeException("HTTP $code: $body")
            val j = JSONObject(body)
            j.optLong("size", 0L) to j.optLong("mtime", 0L)
        } finally { conn.disconnect() }
    }

    // ------- Claude history -------

    suspend fun listClaudeSessions(query: String?): List<ClaudeSession> = withContext(Dispatchers.IO) {
        val q = query?.trim().orEmpty()
        val p = if (q.isEmpty()) "/api/claude/sessions" else "/api/claude/sessions?q=${URLEncoder.encode(q, "UTF-8")}"
        val resp = textRequest("GET", p, null)
        val o = JSONObject(resp)
        val arr = o.optJSONArray("sessions") ?: JSONArray()
        (0 until arr.length()).map { i ->
            val e = arr.getJSONObject(i)
            ClaudeSession(
                id = e.getString("id"),
                cwd = e.optString("cwd", ""),
                firstPrompt = e.optString("firstPrompt", ""),
                messageCount = e.optInt("messageCount", 0),
                lastModified = e.optLong("lastModified", 0L),
                size = e.optLong("size", 0L),
                gitBranch = e.optString("gitBranch", ""),
                projectDir = e.optString("projectDir", ""),
            )
        }
    }

    // ------- internals -------

    private fun textRequest(method: String, path: String, body: String?): String {
        val conn = openConnection(method, path, true, if (body != null) "application/json; charset=utf-8" else null)
        try {
            if (body != null) {
                conn.doOutput = true
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw RuntimeException("HTTP $code: $text")
            return text
        } finally { conn.disconnect() }
    }

    private fun openConnection(method: String, path: String, auth: Boolean, contentType: String?): HttpURLConnection {
        val sep = if (path.contains("?")) "&" else "?"
        val withToken = if (auth && token.isNotEmpty()) "$path${sep}token=${URLEncoder.encode(token, "UTF-8")}" else path
        val url = URL("$baseUrl$withToken")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 5000
        conn.readTimeout = 15000
        if (contentType != null) conn.setRequestProperty("Content-Type", contentType)
        conn.setRequestProperty("Accept", "application/json, text/plain, */*")
        return conn
    }

    private fun parseSession(o: JSONObject): SessionInfo = SessionInfo(
        id = o.getString("id"),
        name = o.optString("name", ""),
        cwd = o.optString("cwd", ""),
        autorun = o.optString("autorun", ""),
        createdAt = o.optLong("createdAt", 0L),
        lastActivityAt = o.optLong("lastActivityAt", 0L),
        cols = o.optInt("cols", 80),
        rows = o.optInt("rows", 24),
        clientCount = o.optInt("clientCount", 0),
        alive = o.optBoolean("alive", true),
        preview = o.optString("preview", ""),
        tmuxName = o.optString("tmuxName", ""),
        macAttachCommand = o.optString("macAttachCommand", ""),
    )

    private fun parseEntries(arr: JSONArray): List<FsEntry> {
        val out = ArrayList<FsEntry>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out += FsEntry(
                name = o.optString("name", ""),
                isDir = o.optBoolean("isDir", false),
                isSymlink = o.optBoolean("isSymlink", false),
                size = o.optLong("size", 0L),
                mtime = o.optLong("mtime", 0L),
                ext = o.optString("ext", ""),
                mime = o.optString("mime", ""),
                kind = o.optString("kind", ""),
            )
        }
        return out
    }

    private fun parseQueryParam(query: String?, key: String): String? {
        if (query.isNullOrEmpty()) return null
        for (pair in query.split("&")) {
            val idx = pair.indexOf('=')
            if (idx <= 0) continue
            if (pair.substring(0, idx) == key) return pair.substring(idx + 1)
        }
        return null
    }
}
