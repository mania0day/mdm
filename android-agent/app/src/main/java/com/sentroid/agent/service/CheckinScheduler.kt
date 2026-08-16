package com.sentroid.agent.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Schedules battery-friendly, Doze-aware check-ins via AlarmManager.
 *
 * We deliberately use `setAndAllowWhileIdle` (inexact): it needs no special
 * permission on any Android version, still fires during Doze, and lets the OS
 * batch/stretch wake-ups so an idle device barely uses battery — while an active
 * or moving device is polled promptly. This replaces holding a wake lock 24/7.
 */
object CheckinScheduler {
    private const val REQ = 7001

    private fun pendingIntent(context: Context): PendingIntent {
        val i = Intent(context, CheckinAlarmReceiver::class.java)
            .setAction(CheckinAlarmReceiver.ACTION_ALARM)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getBroadcast(context, REQ, i, flags)
    }

    /** Schedule the next check-in ~[seconds] from now (clamped to a sane range).
     *  Floor is 1s so the screen-on long-poll can reopen almost immediately; the
     *  battery-friendly idle cadence uses much larger values, and Doze batches the
     *  inexact alarm regardless when the device is actually idle. */
    fun scheduleNext(context: Context, seconds: Int) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAt = System.currentTimeMillis() + seconds.coerceIn(1, 3600) * 1000L
        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent(context))
        } catch (e: Exception) {
            android.util.Log.e("CheckinScheduler", "failed to schedule alarm", e)
        }
    }

    fun cancel(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        try { am.cancel(pendingIntent(context)) } catch (_: Exception) {}
    }
}
