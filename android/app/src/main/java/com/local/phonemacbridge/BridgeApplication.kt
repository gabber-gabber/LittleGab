package com.local.phonemacbridge

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

/**
 * Sets up notification channels on process start and kicks the NotifyService
 * off if the user already has a server URL configured.
 *
 * Two channels:
 *   - `bridge_foreground` (IMPORTANCE_MIN, no badge): the persistent
 *     "listening…" notification the foreground service requires.
 *   - `bridge_event` (IMPORTANCE_HIGH, badged, public on lockscreen): the one
 *     users actually care about — "task done" / "need confirm". Lockscreen
 *     visibility PUBLIC so notifications show on the lock screen.
 */
class BridgeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        createChannels()
        val prefs = Prefs(this)
        if (prefs.notificationsEnabled && prefs.url.isNotBlank()) {
            NotifyService.start(this)
        }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return

        // Discard channel definitions from previous app versions. The OS keeps
        // the originally-created importance/badge/visibility forever otherwise
        // — the very reason we version the IDs.
        for (oldId in NotifyService.OLD_CHANNEL_IDS) {
            try { nm.deleteNotificationChannel(oldId) } catch (_: Exception) {}
        }

        val fg = NotificationChannel(
            NotifyService.CHANNEL_FG,
            "会话监听",
            NotificationManager.IMPORTANCE_MIN,
        ).apply {
            description = "后台监听 Mac 上的会话事件"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(fg)

        val event = NotificationChannel(
            NotifyService.CHANNEL_EVENT,
            "会话事件",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "任务完成 / 需要 yes/no 时推送(锁屏可见)"
            setShowBadge(true)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 220, 120, 220)
            enableLights(true)
            lightColor = 0xFF4F8CFFL.toInt()
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(false)
        }
        nm.createNotificationChannel(event)
    }
}
