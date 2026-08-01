package com.sentroid.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sentroid.agent.data.Prefs

/**
 * Fired by AlarmManager to trigger a single check-in cycle. Kept tiny: it just
 * asks the foreground service to run one cycle (which acquires a short timed wake
 * lock, does the work, and schedules the next alarm). A manifest receiver, so it
 * still runs — and resurrects the service — even if the process was killed.
 */
class CheckinAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ALARM) return
        if (!Prefs(context).isEnrolled) return
        SentroidService.triggerCheckin(context)
    }

    companion object {
        const val ACTION_ALARM = "com.sentroid.agent.action.CHECKIN_ALARM"
    }
}
