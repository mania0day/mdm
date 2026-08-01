package com.sentroid.agent

import android.app.Application
import android.app.PendingIntent
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.util.Log
import com.sentroid.agent.data.Prefs
import com.sentroid.agent.service.SentroidService

/**
 * Application entry point. Starts the agent service if enrolled and installs a
 * last-resort uncaught-exception handler so an unexpected error never leaves the
 * agent permanently dead — it is logged and the app is scheduled to restart.
 */
class SentroidApp : Application() {
    override fun onCreate() {
        super.onCreate()
        installCrashRecovery()
        val prefs = Prefs(this)
        // Start the agent if already enrolled, or if provisioning left a pending
        // enrollment token to consume (QR / zero-touch onboarding).
        if (prefs.isEnrolled || prefs.pendingEnrollToken != null) {
            SentroidService.start(this)
        }
    }

    private fun installCrashRecovery() {
        val default = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            Log.e("SentroidApp", "Uncaught exception on ${thread.name}", throwable)
            try {
                // Schedule a restart of the launcher/service ~2s later, then let the
                // process terminate cleanly.
                val intent = packageManager.getLaunchIntentForPackage(packageName)
                    ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (intent != null) {
                    val pi = PendingIntent.getActivity(
                        this, 0, intent,
                        PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
                    )
                    val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
                    am.set(AlarmManager.RTC, System.currentTimeMillis() + 2000, pi)
                }
            } catch (e: Exception) {
                Log.e("SentroidApp", "restart scheduling failed", e)
            } finally {
                default?.uncaughtException(thread, throwable)
                    ?: run { android.os.Process.killProcess(android.os.Process.myPid()) }
            }
        }
    }
}
