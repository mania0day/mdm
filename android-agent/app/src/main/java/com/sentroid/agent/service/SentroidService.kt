package com.sentroid.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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

    // Count of consecutive failed check-ins. Drives a fast-retry ladder so the
    // agent reconnects promptly after a reboot (when the network isn't up yet)
    // instead of waiting on the normal, Doze-batched steady-state cadence.
    private var consecutiveFailures = 0

    // Fires a check-in the instant network connectivity (re)appears — the main
    // fix for "connection not established / very late after a restart".
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    // Kicks an immediate check-in when the user wakes the screen, so low-latency
    // long-poll mode engages at once instead of on the next idle-cadence alarm.
    private var screenReceiver: BroadcastReceiver? = null

    // Fast, independent re-lock loop for DISABLE — separate from the check-in
    // cycle (which can be minutes apart) so a disabled device is actually
    // unusable, not just re-locked once every check-in.
    private val enforceHandler = Handler(Looper.getMainLooper())
    private var enforceLoopStarted = false
    private val enforceRunnable = object : Runnable {
        override fun run() {
            enforceDisableLock()
            enforceHandler.postDelayed(this, DISABLE_ENFORCE_INTERVAL_MS)
        }
    }

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

        if (!enforceLoopStarted) {
            enforceLoopStarted = true
            enforceHandler.post(enforceRunnable)
        }
        registerNetworkCallback()
        registerScreenReceiver()

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

    /** Runs every ~2s while the service is alive; re-locks immediately if the
     * device is administratively disabled and someone has woken the screen. */
    private fun enforceDisableLock() {
        val prefs = Prefs(applicationContext)
        if (!prefs.disabled) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isInteractive) {
            try {
                PolicyManager(applicationContext).lockNow()
            } catch (_: Exception) {
                // Best-effort — the next tick (2s later) retries.
            }
        }
    }

    /**
     * Register a default-network callback that kicks off an immediate check-in the
     * moment connectivity (re)appears.
     *
     * This is the real fix for "stuck / connection very late after a restart":
     * right after boot the radios/Wi-Fi are usually not up yet, so the first
     * check-in fails, and the *next* attempt would otherwise wait on an inexact,
     * Doze-batched AlarmManager alarm that the OS can stretch to minutes. Reacting
     * to onAvailable reconnects within ~a second of the network actually coming
     * back, independent of the alarm cadence. Idempotent — safe to call on every
     * onStartCommand (each alarm-driven start re-enters here).
     */
    private fun registerNetworkCallback() {
        if (netCallback != null) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Only chase a reconnect if we actually have something to report.
                // triggerCheckin (not start) so recent per-command notifications
                // aren't cleared on every network change.
                if (Prefs(applicationContext).isEnrolled) triggerCheckin(applicationContext)
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Exception) {
            android.util.Log.w("SentroidService", "network callback registration failed", e)
        }
    }

    /**
     * Register a dynamic receiver that triggers an immediate check-in when the
     * screen turns on. Without it, waking the phone to send a command would wait
     * up to a full idle interval before the agent switched into low-latency
     * long-poll mode. ACTION_SCREEN_ON can't be declared in the manifest, so it
     * must be registered at runtime, and only lives as long as the service.
     */
    private fun registerScreenReceiver() {
        if (screenReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_ON &&
                    Prefs(applicationContext).isEnrolled
                ) {
                    triggerCheckin(applicationContext)
                }
            }
        }
        val filter = IntentFilter(Intent.ACTION_SCREEN_ON)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(r, filter)
            }
            screenReceiver = r
        } catch (e: Exception) {
            android.util.Log.w("SentroidService", "screen receiver registration failed", e)
        }
    }

    override fun onDestroy() {
        enforceHandler.removeCallbacks(enforceRunnable)
        netCallback?.let { cb ->
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
                    ?.unregisterNetworkCallback(cb)
            } catch (_: Exception) {
            }
        }
        netCallback = null
        screenReceiver?.let { r -> try { unregisterReceiver(r) } catch (_: Exception) {} }
        screenReceiver = null
        // Note: we intentionally do NOT cancel the check-in alarm here — if the
        // system kills the service, the next alarm resurrects it. The alarm is
        // cancelled only on explicit unenroll.
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
                consecutiveFailures = 0
            } catch (t: Throwable) {
                android.util.Log.e("SentroidService", "check-in cycle failed", t)
                updateNotification("SENTROID agent", "Reconnecting…")
                // Fast-retry ladder: while a check-in keeps failing — the usual case
                // in the seconds just after a reboot, before the network is up — poll
                // back quickly instead of dropping to the slow steady-state retry.
                // The network-available callback normally beats this to it, but the
                // ladder guarantees prompt recovery even if that signal is missed.
                consecutiveFailures++
                nextDelay = if (consecutiveFailures <= FAST_RETRY_ATTEMPTS) FAST_RETRY_INTERVAL else RETRY_INTERVAL
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

        // Long-poll only while the screen is on. A held connection keeps the CPU
        // awake, but when the screen is already on that costs nothing extra — and
        // it's exactly when an operator is issuing commands and expecting them to
        // land instantly. Screen off: hold=0, so we fall back to the normal
        // battery-friendly, Doze-batched cadence with no held connection.
        val powerMgr = getSystemService(Context.POWER_SERVICE) as PowerManager
        val interactive = powerMgr.isInteractive
        val hold = if (interactive) LONGPOLL_HOLD_S else 0

        val startMs = android.os.SystemClock.elapsedRealtime()
        val result = api.checkin(buildTelemetry(policyMgr), hold)
        val elapsedMs = android.os.SystemClock.elapsedRealtime() - startMs
        prefs.checkinInterval = result.intervalSeconds
        prefs.lastCompliance = result.compliance
        prefs.lastViolations = result.violations
        prefs.allowReconfigure = result.allowReconfigure
        result.policy?.let {
            prefs.lastPolicyJson = it.toString()
            policyMgr.applyPolicy(it)
        }

        for (cmd in result.commands) {
            val (status, message) = executor.execute(cmd, result.policy)
            try {
                // Reuse the client captured before the command ran, rather than
                // rebuilding one from prefs. REMOTE_UNINSTALL deliberately wipes
                // the stored credentials as part of its work, so a client built
                // after execution would have no token and the result would 401 —
                // leaving the command stuck at 'sent' in the console forever.
                api.reportResult(cmd.id, status, message)
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

        // Choose when to poll again.
        //  - Screen on: reopen the long-poll almost immediately so the next command
        //    lands in ~1s. Guard against an old server that doesn't actually hold
        //    the request: if it returned near-instantly with nothing, don't hammer
        //    it — poll at a modest active rate instead.
        //  - Screen off: honor the server's interval, clamped to the battery floor.
        if (!interactive) {
            return result.intervalSeconds.coerceIn(MIN_INTERVAL, MAX_INTERVAL)
        }
        val serverHeld = result.commands.isNotEmpty() || elapsedMs >= hold * 1000L / 2
        return if (serverHeld) LONGPOLL_REARM_S else ACTIVE_POLL_S
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
            .put("is_rooted", DeviceInfo.isRooted(ctx))
            .put("management_mode", DeviceInfo.managementMode(ctx))
            .put("build_fingerprint", DeviceInfo.buildFingerprint())
            .put("security_patch", DeviceInfo.securityPatch())
            // Real keyguard state. Without this the console can only ever show
            // the lock state it *commanded*, so a user unlocking their own
            // phone would leave the device pinned at "locked" forever.
            .put("device_locked", DeviceInfo.isDeviceLocked(ctx))
            .put("password_set", DeviceInfo.isPasswordSet(ctx))
        DeviceInfo.imei(ctx)?.let { body.put("imei", it) }
        DeviceInfo.phoneNumber(ctx)?.let { body.put("phone_number", it) }
        DeviceInfo.simOperator(ctx)?.let { body.put("sim_operator", it) }
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

    /**
     * Commands that are routine/high-frequency (a status check, a location
     * poll) do NOT get a heads-up banner — only a quiet, low-importance entry
     * in the shade. Only actions that change the device's security posture
     * (lock, wipe, disable, policy changes, password reset) interrupt the
     * user, and each does so at most once per type (stable notification id).
     */
    private val quietCommandTypes = setOf("PING", "LOCATE")

    private fun ensureActionChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(ACTION_CHANNEL_ID) == null) {
                // IMPORTANCE_HIGH so each executed *security-relevant* action pops
                // a visible heads-up banner (clear on-device confirmation), but
                // silent (no sound/vibration) so it isn't noisy.
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
            if (nm.getNotificationChannel(QUIET_CHANNEL_ID) == null) {
                // IMPORTANCE_LOW: no heads-up, no sound — for routine check-ins
                // (ping / locate) that shouldn't interrupt the user every cycle.
                nm.createNotificationChannel(
                    NotificationChannel(
                        QUIET_CHANNEL_ID,
                        "SENTROID Routine Check-ins",
                        NotificationManager.IMPORTANCE_LOW,
                    ).apply {
                        description = "Routine status/location polling — no interruption"
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
        val quiet = type in quietCommandTypes
        val n = NotificationCompat.Builder(this, if (quiet) QUIET_CHANNEL_ID else ACTION_CHANNEL_ID)
            .setContentTitle("SENTROID  ·  $label")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setSmallIcon(R.drawable.ic_shield)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setPriority(if (quiet) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setSilent(true)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Stable id per command type: re-issuing the same action updates its
        // existing notification instead of stacking duplicates or repeatedly
        // interrupting the user.
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
        private const val QUIET_CHANNEL_ID = "sentroid_actions_quiet"
        private const val NOTIF_ID = 1001
        private const val ACTION_ID_BASE = 2000

        // Timing (seconds). The server can raise the interval; the floor keeps the
        // device responsive when active. Doze naturally stretches alarms far beyond
        // this when the device is idle, which is where the battery savings come from.
        private const val MIN_INTERVAL = 15
        private const val MAX_INTERVAL = 3600
        private const val DEFAULT_INTERVAL = 30
        private const val RETRY_INTERVAL = 30
        // Post-reboot / outage fast-retry: poll back at the floor cadence for the
        // first few failures so a reconnect isn't stranded behind a Doze-batched
        // steady-state alarm. FAST_RETRY_INTERVAL is clamped up to the 15s alarm
        // floor by CheckinScheduler either way.
        private const val FAST_RETRY_INTERVAL = 15
        private const val FAST_RETRY_ATTEMPTS = 6

        // Low-latency command delivery while the screen is on (see performCheckin).
        // LONGPOLL_HOLD_S: how long the server may hold each check-in open.
        // LONGPOLL_REARM_S: gap before reopening the long-poll (commands issued in
        //   this window wait at most this long; commands issued while the poll is
        //   open arrive instantly). ACTIVE_POLL_S: fallback rate when the screen is
        //   on but the server didn't hold the request (e.g. an older server).
        private const val LONGPOLL_HOLD_S = 25
        private const val LONGPOLL_REARM_S = 1
        private const val ACTIVE_POLL_S = 5
        private const val CYCLE_WAKELOCK_MS = 55_000L
        private const val DISABLE_ENFORCE_INTERVAL_MS = 2_000L

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
