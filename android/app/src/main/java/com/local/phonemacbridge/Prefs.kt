package com.local.phonemacbridge

import android.content.Context
import android.content.SharedPreferences

class Prefs(ctx: Context) {
    private val sp: SharedPreferences =
        ctx.applicationContext.getSharedPreferences("phone_mac_bridge", Context.MODE_PRIVATE)

    var url: String
        get() = sp.getString(KEY_URL, "") ?: ""
        set(v) { sp.edit().putString(KEY_URL, v).apply() }

    /** On by default. The service is a no-op until the URL is set anyway. */
    var notificationsEnabled: Boolean
        get() = sp.getBoolean(KEY_NOTIFS, true)
        set(v) { sp.edit().putBoolean(KEY_NOTIFS, v).apply() }

    /**
     * Epoch-ms of the newest notification the NotifyService has successfully
     * shown. Used when reconnecting so the server only replays newer ones.
     */
    var lastNotifySeenAt: Long
        get() = sp.getLong(KEY_LAST_NOTIFY, 0L)
        set(v) { sp.edit().putLong(KEY_LAST_NOTIFY, v).apply() }

    companion object {
        private const val KEY_URL = "server_url"
        private const val KEY_NOTIFS = "notifications_enabled"
        private const val KEY_LAST_NOTIFY = "last_notify_seen_at"
    }
}
