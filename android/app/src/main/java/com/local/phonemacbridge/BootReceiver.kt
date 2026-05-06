package com.local.phonemacbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restart the NotifyService after device boot or package upgrade so the user
 * doesn't have to open the app to re-arm notifications.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(context)
        if (prefs.notificationsEnabled && prefs.url.isNotBlank()) {
            NotifyService.start(context)
        }
    }
}
