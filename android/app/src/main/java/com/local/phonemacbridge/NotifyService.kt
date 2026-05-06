package com.local.phonemacbridge

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.TaskStackBuilder
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlin.math.min
import me.leolin.shortcutbadger.ShortcutBadger

/**
 * Foreground service that keeps a WebSocket open to /notify on the bridge
 * server and surfaces incoming notifications via the system notification
 * manager. Lives across app background / lock-screen so the user hears the
 * "task done" / "need confirm" events without the WebView being alive.
 *
 * Only one thing is asymmetric: the in-app terminal WebSocket is separate
 * (handled in app.js inside the WebView). We deliberately don't reuse that
 * socket — it only exists while a session is being viewed, and notifications
 * must work regardless of which session (if any) is open.
 */
class NotifyService : Service() {

    companion object {
        // Channel IDs are versioned. NotificationChannel settings (importance,
        // showBadge, lockscreenVisibility, …) become immutable after the first
        // create*Channel call. If you tune those values you HAVE to bump the
        // suffix here, otherwise existing installs keep the old (cached)
        // settings even after upgrade. BridgeApplication.deleteOldChannels
        // tidies up the previous-id leftovers when this changes.
        const val CHANNEL_FG = "bridge_foreground_v2"
        const val CHANNEL_EVENT = "bridge_event_v2"
        val OLD_CHANNEL_IDS = arrayOf("bridge_foreground", "bridge_event")
        private const val FG_NOTIF_ID = 1001
        private const val TAG = "NotifyService"

        fun start(ctx: Context) {
            val i = Intent(ctx, NotifyService::class.java)
            try { ContextCompat.startForegroundService(ctx, i) } catch (e: Exception) {
                Log.w(TAG, "startForegroundService failed: ${e.message}")
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, NotifyService::class.java))
        }

        /**
         * Clear any pending event notifications for a specific session and
         * decrement the launcher badge count.  Called when the user opens a
         * session so they don't have to swipe the notification away after
         * they've already seen the page.
         */
        fun clearSessionNotifications(ctx: Context, sessionId: String) {
            val nm = NotificationManagerCompat.from(ctx)
            // Same id-derivation as postEventNotification.
            for (kind in arrayOf("confirm", "done")) {
                val id = ("$sessionId:$kind").hashCode().let { if (it == 0) 1 else it }
                nm.cancel(id)
            }
            // Recompute the badge count from whatever's still in the tray.
            val active = try {
                ctx.getSystemService(android.app.NotificationManager::class.java)
                    ?.activeNotifications?.count { it.notification?.channelId == CHANNEL_EVENT } ?: 0
            } catch (_: Exception) { 0 }
            try { ShortcutBadger.applyCount(ctx.applicationContext, active) } catch (_: Exception) {}
        }

        fun clearAllBadges(ctx: Context) {
            try { ShortcutBadger.removeCount(ctx.applicationContext) } catch (_: Exception) {}
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private lateinit var client: OkHttpClient
    private var currentWs: WebSocket? = null
    private var connectJob: Job? = null
    @Volatile private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        client = OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // long-lived WS
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(FG_NOTIF_ID, buildForegroundNotif())
        if (!running) {
            running = true
            connectJob = scope.launch { connectLoop() }
        }
        return START_STICKY
    }

    private suspend fun connectLoop() {
        val prefs = Prefs(this)
        var backoff = 1000L
        while (running) {
            if (!prefs.notificationsEnabled) {
                stopSelf(); return
            }
            val parsed = parseUrl(prefs.url)
            if (parsed == null) {
                // No URL configured — sleep long, check again. No point spinning.
                delay(30_000); continue
            }
            val (wsUrl, token) = parsed
            val fullUrl = "$wsUrl?token=$token&since=${prefs.lastNotifySeenAt}"
            val ok = runOneSocket(fullUrl, prefs)
            if (!running) break
            backoff = if (ok) 1000L else min(30_000L, (backoff * 1.7).toLong())
            delay(backoff)
        }
    }

    // Blocks until the socket closes or fails. Returns true on clean close.
    private suspend fun runOneSocket(url: String, prefs: Prefs): Boolean {
        val latch = kotlinx.coroutines.CompletableDeferred<Boolean>()
        val req = Request.Builder().url(url).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                currentWs = webSocket
                Log.i(TAG, "notify ws open")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                try { handleMessage(text, prefs) } catch (e: Exception) {
                    Log.w(TAG, "bad notify payload: ${e.message}")
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                currentWs = null
                if (!latch.isCompleted) latch.complete(true)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "notify ws failure: ${t.message}")
                currentWs = null
                if (!latch.isCompleted) latch.complete(false)
            }
        }
        val ws = client.newWebSocket(req, listener)
        try { return latch.await() } finally {
            try { ws.cancel() } catch (_: Exception) {}
        }
    }

    private fun handleMessage(text: String, prefs: Prefs) {
        val j = JSONObject(text)
        val id = j.optString("id", "")
        val kind = j.optString("kind", "")
        val sessionId = j.optString("sessionId", "")
        val sessionName = j.optString("sessionName", "")
        val at = j.optLong("at", System.currentTimeMillis())
        val snippet = j.optString("snippet", "").trim()
        if (id.isEmpty() || sessionId.isEmpty() || kind.isEmpty()) return
        postEventNotification(kind, sessionId, sessionName, at, snippet)
        if (at > prefs.lastNotifySeenAt) prefs.lastNotifySeenAt = at
    }

    private fun buildForegroundNotif(): Notification {
        // Foreground services on Android 8+ require a notification, but we
        // make ours as invisible as the platform allows: MIN priority, no
        // sound/vibration, channel has setShowBadge(false), and FOREGROUND_
        // SERVICE_DEFERRED lets Android hide it for the first 10s — usually
        // long enough for the user not to notice on a quick app open.
        val openIntent = Intent(this, ConversationListActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_FG)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("LittleGab 后台监听中")
            .setContentText("收到任务完成 / 需要确认时会通知你")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setShowWhen(false)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
    }

    private fun postEventNotification(
        kind: String,
        sessionId: String,
        sessionName: String,
        at: Long,
        snippet: String,
    ) {
        val title = when (kind) {
            "confirm" -> "需要确认:${sessionName.ifEmpty { sessionId }}"
            "done" -> "任务完成:${sessionName.ifEmpty { sessionId }}"
            else -> sessionName.ifEmpty { "LittleGab" }
        }
        val tap = Intent(this, SessionActivity::class.java).apply {
            putExtra(SessionActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(SessionActivity.EXTRA_SESSION_NAME, sessionName)
        }
        // TaskStackBuilder honours parentActivityName in the manifest so that
        // tapping the notification lands in SessionActivity with
        // ConversationListActivity correctly set as the back target, even if
        // the app wasn't running.
        val pi = TaskStackBuilder.create(this)
            .addNextIntentWithParentStack(tap)
            .getPendingIntent(
                sessionId.hashCode(),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val text = snippet.ifEmpty { if (kind == "confirm") "等你回应 y/n" else "执行完成" }
        val n = NotificationCompat.Builder(this, CHANNEL_EVENT)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(
                if (kind == "confirm") NotificationCompat.CATEGORY_CALL
                else NotificationCompat.CATEGORY_MESSAGE,
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setWhen(at)
            .setContentIntent(pi)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setNumber(1) // some launchers use this for the badge count
            .build()
        // Stable id so a repeat confirm for the same session replaces rather
        // than stacks. `notifId` is random per event; use sessionId+kind instead.
        val id = (sessionId + ":" + kind).hashCode().let { if (it == 0) 1 else it }
        val nm = NotificationManagerCompat.from(this)

        // Pre-check why a notify() might silently no-op so we can log the real
        // reason and ack it back to the server. Without this, a user who never
        // granted POST_NOTIFICATIONS or who turned the channel off in system
        // settings sees nothing and the network looks identical to "working."
        val reason = whyBlocked()
        if (reason != null) {
            Log.w(TAG, "notify suppressed: $reason  (kind=$kind sessionId=$sessionId)")
            sendAck(id, kind, "blocked:$reason")
            return
        }

        try {
            nm.notify(id, n)
            sendAck(id, kind, "ok")
            // Bump the launcher badge. ShortcutBadger handles the OEM-specific
            // broadcasts (Samsung/Xiaomi/Huawei/OPPO/ColorOS/...). We pass the
            // count of currently-active event notifications, recomputed each
            // time so the dot disappears once the user dismisses them.
            val active = try {
                getSystemService(android.app.NotificationManager::class.java)
                    ?.activeNotifications?.count { it.notification?.channelId == CHANNEL_EVENT } ?: 0
            } catch (_: Exception) { 0 }
            try { ShortcutBadger.applyCount(applicationContext, active) } catch (_: Exception) {}
        } catch (e: SecurityException) {
            Log.w(TAG, "notify SecurityException: ${e.message}")
            sendAck(id, kind, "security_exception")
        }
    }

    /** Returns null if notifications can fire, or a short reason string if not. */
    private fun whyBlocked(): String? {
        val nm = NotificationManagerCompat.from(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.POST_NOTIFICATIONS
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) return "post_notifications_denied"
        }
        if (!nm.areNotificationsEnabled()) return "app_notifications_off"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val sys = getSystemService(android.app.NotificationManager::class.java)
            val ch = sys?.getNotificationChannel(CHANNEL_EVENT)
            if (ch == null) return "channel_missing"
            if (ch.importance == android.app.NotificationManager.IMPORTANCE_NONE)
                return "event_channel_off"
        }
        return null
    }

    /**
     * Lightweight upstream ack so the *server log* can tell us whether each
     * push reached the tray. Removes the need for adb/logcat for this kind of
     * diagnostic. Server side just prints whatever it gets on this socket.
     */
    private fun sendAck(id: Int, kind: String, status: String) {
        val ws = currentWs ?: return
        try {
            val j = JSONObject()
            j.put("ack", true)
            j.put("kind", kind)
            j.put("notifId", id)
            j.put("status", status)
            ws.send(j.toString())
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        running = false
        try { currentWs?.close(1000, "service stopping") } catch (_: Exception) {}
        scope.cancel()
        super.onDestroy()
    }

    /**
     * Parse the user's stored URL (may carry a `?token=…` query) into
     * (wsEndpoint, token). Returns null on malformed.
     */
    private fun parseUrl(stored: String): Pair<String, String>? {
        if (stored.isBlank()) return null
        return try {
            val u = URL(stored)
            val scheme = if (u.protocol == "https") "wss" else "ws"
            val portPart = if (u.port == -1) "" else ":${u.port}"
            val token = u.query?.split("&")?.firstNotNullOfOrNull { p ->
                val eq = p.indexOf('=')
                if (eq > 0 && p.substring(0, eq) == "token") p.substring(eq + 1) else null
            }.orEmpty()
            Pair("$scheme://${u.host}$portPart/notify", token)
        } catch (_: Exception) { null }
    }
}
