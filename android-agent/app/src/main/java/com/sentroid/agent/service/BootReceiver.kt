package com.sentroid.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sentroid.agent.data.Prefs

/** Restart the secure check-in service after the device reboots. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) {
            if (Prefs(context).isEnrolled) {
                SentroidService.start(context)
            }
        }
    }
}
