package com.sentroid.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.sentroid.agent.MainActivity
import com.sentroid.agent.R
import com.sentroid.agent.data.ApiClient
import com.sentroid.agent.data.EnrollmentManager
import com.sentroid.agent.data.Prefs
import com.sentroid.agent.policy.PolicyManager
import com.sentroid.agent.util.DeviceInfo
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service implementing the secure check-in loop. (Proposal 5.4
 * monitoring, 7.2 operational workflow)
 *
 * Battery-optimized design: the service stays foreground so the process is kept
 * alive and reliable, but it does NOT hold a wake lock or busy-loop between
 * check-ins. Instead each check-in is driven by an AlarmManager alarm
 * (`CheckinScheduler`), and only during the brief cycle do we hold a short,
 * self-releasing wake lock. On an idle device the OS batches these alarms (Doze),
 * so battery use is minimal; an active/moving device is polled promptly.
 */
class SentroidService : Service() {

    private val cycleRunning = AtomicBoolean(false)
    private var pollCount = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("SENTROID agent active", "Secure management enabled"))
        // Clear leftover per-command action notifications ONLY on a genuine fresh
        // start (app launch / boot / reprovision) — NOT on every alarm-driven
        // check-in, or we would wipe the very confirmations the admin just triggered.
        if (intent?.action != ACTION_CHECKIN) {
            val nm0 = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            for (id in ACTION_ID_BASE..ACTION_ID_BASE + 50) nm0.cancel(id)
        }

        val p = Prefs(applicationContext)
        if (p.isEnrolled || p.pendingEnrollToken != null) {
            // Run one cycle now (immediate check-in on start/boot/alarm, or auto-
            // enroll if provisioned via QR); the cycle schedules the next alarm.
            runCycle()
        } else {
            // Not enrolled yet: check back shortly rather than spinning.
            CheckinScheduler.scheduleNext(applicationContext, 30)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        // Note: we intentionally do NOT cancel the alarm here — if the system kills
        // the service, the next alarm resurrects it. The alarm is cancelled only on
        // explicit unenroll.
        super.onDestroy()
    }

    /**
     * Perform one check-in cycle under a short, timed wake lock, then schedule the
     * next alarm and release the lock. Guarded so only one cycle runs at a time.
     */
    private fun runCycle() {
        if (!cycleRunning.compareAndSet(false, true)) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sentroid:checkin").apply {
            setReferenceCounted(false)
        }
        try { wl.acquire(CYCLE_WAKELOCK_MS) } catch (_: Exception) {}
        Thread {
            var nextDelay = DEFAULT_INTERVAL
            try {
                nextDelay = performCheckin()
            } catch (t: Throwable) {
                android.util.Log.e("SentroidService", "check-in cycle failed", t)
                updateNotification("SENTROID agent", "Reconnecting…")
                nextDelay = RETRY_INTERVAL
            } finally {
                // Always chain the next alarm so the loop can never silently stop.
                CheckinScheduler.scheduleNext(applicationContext, nextDelay)
                try { if (wl.isHeld) wl.release() } catch (_: Exception) {}
                cycleRunning.set(false)
            }
        }.apply { isDaemon = true }.start()
    }

    /** One telemetry report + command pull/execute. Returns the next delay (s). */
    private fun performCheckin(): Int {
        val prefs = Prefs(applicationContext)
        if (!prefs.isEnrolled) {
            // QR/zero-touch provisioned: auto-enroll using the token from the QR as
            // soon as the network is reachable, then continue with a normal check-in.
            val pending = prefs.pendingEnrollToken
            if (pending != null && prefs.serverUrl.isNotEmpty()) {
                val err = EnrollmentManager.enroll(applicationContext, prefs.serverUrl, pending)
                if (err == null) {
                    prefs.pendingEnrollToken = null
                    updateNotification("SENTROID enrolled", "Device provisioned and enrolled")
                } else {
                    updateNotification("SENTROID", "Waiting to enroll… ($err)")
                    return RETRY_INTERVAL
                }
            } else {
                return DEFAULT_INTERVAL
            }
        }
        pollCount++

        // If administratively disabled, re-lock ONLY when the screen is on (someone
        // woke the device); re-locking an already-off screen just wastes power.
        if (prefs.disabled) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (pm.isInteractive) PolicyManager(applicationContext).lockNow()
        }

        val policyMgr = PolicyManager(applicationContext)
        val executor = CommandExecutor(applicationContext)
        val api = ApiClient(prefs.serverUrl, prefs.deviceToken)

        val result = api.checkin(buildTelemetry(policyMgr))
        prefs.checkinInterval = result.intervalSeconds
        result.policy?.let {
            prefs.lastPolicyJson = it.toString()
            policyMgr.applyPolicy(it)
        }

        for (cmd in result.commands) {
            val (status, message) = executor.execute(cmd, result.policy)
            try {
                ApiClient(prefs.serverUrl, prefs.deviceToken).reportResult(cmd.id, status, message)
            } catch (_: Exception) {
                // Result will be retried implicitly; command stays 'sent'.
            }
            updateNotification("Executed ${cmd.type}", message)
            // A separate, dismissible notification per executed command so the
            // shade shows an at-a-glance record of every remote action.
            postActionNotification(cmd.type, message)
        }
        if (result.commands.isEmpty()) {
            updateNotification("SENTROID agent active", "Compliance: ${result.compliance}")
        }
        return result.intervalSeconds.coerceIn(MIN_INTERVAL, MAX_INTERVAL)
    }

    private fun buildTelemetry(policyMgr: PolicyManager): JSONObject {
        val ctx = applicationContext
        val body = JSONObject()
            .put("battery_level", DeviceInfo.batteryLevel(ctx))
            .put("battery_charging", DeviceInfo.batteryCharging(ctx))
            .put("network_type", DeviceInfo.networkType(ctx))
            .put("os_version", DeviceInfo.osVersion())
            .put("admin_active", policyMgr.isAdminActive())
            .put("encryption_on", DeviceInfo.encryptionOn(ctx))
            .put("is_rooted", DeviceInfo.isRooted())
        // Location: serve the cheap cached fix most cycles; refresh GPS only every
        // ~6th check-in (or when the cache is empty) to save battery/CPU.
        val loc = if (pollCount % 6 == 1 || DeviceInfo.cachedLocation() == null) {
            DeviceInfo.requestFreshLocation(ctx, 3500)
        } else {
            DeviceInfo.cachedLocation()
        }
        loc?.let { body.put("latitude", it.first).put("longitude", it.second) }
        return body
    }

    // ---- Notification helpers -------------------------------------------------

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        "SENTROID Agent",
                        NotificationManager.IMPORTANCE_LOW,
                    ).apply { description = "Secure device management status" },
                )
            }
        }
    }

    private fun buildNotification(title: String, text: String): Notification {
        ensureChannel()
        val pi = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_shield)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    private fun updateNotification(title: String, text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(title, text))
    }

    private fun ensureActionChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(ACTION_CHANNEL_ID) == null) {
                // IMPORTANCE_HIGH so each executed remote action pops a visible
                // heads-up banner on the device (clear on-device confirmation),
                // but silent (no sound/vibration) so it isn't noisy.
                nm.createNotificationChannel(
                    NotificationChannel(
                        ACTION_CHANNEL_ID,
                        "SENTROID Remote Actions",
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply {
                        description = "Remote administrator actions executed on this device"
                        setSound(null, null)
                        enableVibration(false)
                    },
                )
            }
        }
    }

    /** Post a distinct, dismissible notification recording one executed command. */
    private fun postActionNotification(type: String, message: String) {
        ensureActionChannel()
        val label = when (type) {
            "PING" -> "Ping received"
            "LOCATE" -> "Location reported"
            "RING" -> "Device rang"
            "LOCK" -> "Device locked"
            "UNLOCK" -> "Device unlocked"
            "DISABLE" -> "Device disabled"
            "ENABLE" -> "Device re-enabled"
            "WIPE" -> "Factory wipe issued"
            "RESET_PASSWORD" -> "Password reset"
            "ENFORCE_POLICY" -> "Policy enforced"
            else -> type
        }
        val pi = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(this, ACTION_CHANNEL_ID)
            .setContentTitle("SENTROID  ·  $label")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setSmallIcon(R.drawable.ic_shield)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            // High priority + status category so it shows as a heads-up banner
            // (pre-O compat) — makes each remote action clearly visible on-device.
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setSilent(true)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Stable id per command type: re-issuing the same action updates its
        // existing notification instead of stacking duplicates.
        nm.notify(actionIdFor(type), n)
    }

    private fun actionIdFor(type: String): Int {
        val offset = when (type) {
            "PING" -> 1
            "LOCATE" -> 2
            "RING" -> 3
            "LOCK" -> 4
            "UNLOCK" -> 5
            "DISABLE" -> 6
            "ENABLE" -> 7
            "WIPE" -> 8
            "RESET_PASSWORD" -> 9
            "ENFORCE_POLICY" -> 10
            else -> 20
        }
        return ACTION_ID_BASE + offset
    }

    companion object {
        private const val CHANNEL_ID = "sentroid_agent"
        // v2: new id so the upgraded IMPORTANCE_HIGH (heads-up) takes effect even
        // on devices that already created the old default-importance channel.
        private const val ACTION_CHANNEL_ID = "sentroid_actions_v2"
        private const val NOTIF_ID = 1001
        private const val ACTION_ID_BASE = 2000

        // Timing (seconds). The server can raise the interval; the floor keeps the
        // device responsive when active. Doze naturally stretches alarms far beyond
        // this when the device is idle, which is where the battery savings come from.
        private const val MIN_INTERVAL = 15
        private const val MAX_INTERVAL = 3600
        private const val DEFAULT_INTERVAL = 30
        private const val RETRY_INTERVAL = 30
        private const val CYCLE_WAKELOCK_MS = 55_000L

        private const val ACTION_CHECKIN = "com.sentroid.agent.action.CHECKIN"

        /** Start (or ensure running) the foreground agent service. */
        fun start(context: Context) {
            val i = Intent(context, SentroidService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(i)
                } else {
                    context.startService(i)
                }
            } catch (e: Exception) {
                // Starting a foreground service from the background can be disallowed
                // on newer Android; it will be (re)started on the next alarm / app open.
            }
        }

        /** Ask the service to perform one check-in cycle (called from the alarm). */
        fun triggerCheckin(context: Context) {
            val i = Intent(context, SentroidService::class.java).setAction(ACTION_CHECKIN)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(i)
                } else {
                    context.startService(i)
                }
            } catch (e: Exception) {
                android.util.Log.w("SentroidService", "triggerCheckin start failed", e)
            }
        }
    }
}
