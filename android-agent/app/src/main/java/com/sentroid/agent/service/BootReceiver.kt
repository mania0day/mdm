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
                // Backup path: also arm a check-in alarm. If starting a foreground
                // service straight from BOOT_COMPLETED is throttled by the OS (newer
                // Android restricts background FGS starts for some service types),
                // the alarm still resurrects the agent shortly after boot instead of
                // leaving it dark until the app is next opened.
                CheckinScheduler.scheduleNext(context, 15)
            }
        }
    }
}
