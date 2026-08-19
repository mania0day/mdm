package com.sentroid.agent.service

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.sentroid.agent.data.CommandDto
import com.sentroid.agent.data.Prefs
import com.sentroid.agent.policy.PolicyManager
import com.sentroid.agent.util.DeviceInfo
import org.json.JSONObject

/**
 * Executes a single remote command and returns a human-readable result string
 * that is reported back to the SENTROID server for the audit trail.
 */
class CommandExecutor(private val context: Context) {
    private val policy = PolicyManager(context)
    private val prefs = Prefs(context)

    fun execute(cmd: CommandDto, lastPolicy: JSONObject?): Pair<String, String> {
        return try {
            when (cmd.type) {
                "LOCK" -> "completed" to policy.lockNow()

                "UNLOCK" -> {
                    // A plain device admin cannot clear an existing password on modern
                    // Android; acknowledge and clear any local disable lock-loop.
                    // The status bar block is lifted too — it is applied by DISABLE,
                    // so leaving it on here would strand the device with a blocked
                    // status bar and no way back short of a second ENABLE.
                    prefs.disabled = false
                    val barResult = policy.setStatusBarBlocked(false)
                    "completed" to "unlock acknowledged (local restrictions cleared); $barResult"
                }

                "WIPE" -> "completed" to policy.wipe()

                "RESTART" -> {
                    val res = policy.reboot()
                    if (res.startsWith("restart requested")) "completed" to res else "failed" to res
                }

                "DISABLE" -> {
                    prefs.disabled = true
                    val lockResult = policy.lockNow()
                    val barResult = policy.setStatusBarBlocked(true)
                    "completed" to "$lockResult; re-locks every check-in until ENABLE; $barResult"
                }

                "ENABLE" -> {
                    prefs.disabled = false
                    val barResult = policy.setStatusBarBlocked(false)
                    "completed" to "device re-enabled; $barResult"
                }

                "RESET_PASSWORD" -> {
                    val pw = cmd.payload.optString("password", "0000")
                    "completed" to policy.resetPassword(pw)
                }

                "ENFORCE_POLICY" -> {
                    val p = lastPolicy ?: prefs.lastPolicyJson?.let { JSONObject(it) }
                    if (p != null) "completed" to policy.applyPolicy(p)
                    else "failed" to "no policy available"
                }

                "LOCATE" -> {
                    // Distinguish the three failure modes — they need different
                    // fixes, and "unavailable" told the operator nothing.
                    if (!DeviceInfo.hasLocationPermission(context)) {
                        promptForLocationPermission()
                        "failed" to "location permission not granted on device — user has been prompted on-device to allow it"
                    } else if (!DeviceInfo.locationServicesEnabled(context)) {
                        promptToEnableLocationServices()
                        "failed" to "location services are turned off on the device — user has been prompted on-device to enable them"
                    } else {
                        val loc = DeviceInfo.requestFreshLocation(context, 12000)
                        if (loc != null) "completed" to "location ${loc.first},${loc.second}"
                        else "failed" to "no GPS/network fix obtained within 12s (device may be indoors)"
                    }
                }

                "LOCATION_ON" -> {
                    val res = policy.setLocationEnabled(true)
                    // On anything short of Device Owner on Android 11+, the OS
                    // will not let us flip the toggle — so ask the user directly
                    // rather than reporting a success that never happened.
                    if (!DeviceInfo.locationServicesEnabled(context)) promptToEnableLocationServices()
                    if (res.startsWith("location turned ON")) "completed" to res else "failed" to res
                }

                "LOCATION_OFF" -> {
                    val res = policy.setLocationEnabled(false)
                    if (res.contains("turned OFF") || res.contains("forced OFF")) "completed" to res
                    else "failed" to res
                }

                "AIRPLANE_MODE_OFF" -> {
                    val res = policy.setAirplaneModeBlocked(true)
                    if (res.startsWith("airplane mode turned OFF")) "completed" to res else "failed" to res
                }

                "AIRPLANE_MODE_ALLOW" -> {
                    val res = policy.setAirplaneModeBlocked(false)
                    if (res.startsWith("airplane mode unblocked")) "completed" to res else "failed" to res
                }

                "PING" -> "completed" to "pong @ ${System.currentTimeMillis()}"

                "RING" -> "completed" to ring()

                "REMOTE_UNINSTALL" -> remoteUninstall()

                else -> "failed" to "unknown command ${cmd.type}"
            }
        } catch (e: Exception) {
            "failed" to "exception: ${e.message}"
        }
    }

    /**
     * Remove SENTROID from the device on admin request, touching nothing else
     * on the phone. Android never lets any app — regardless of privilege
     * level — silently uninstall itself; that's a deliberate OS restriction
     * so malware can't hide itself. The best honest result: drop device
     * admin and local data ourselves, then trigger the system uninstall
     * confirmation so it's a single tap instead of a trip through Settings.
     * A Device Owner app can't be removed this way at all — Android only
     * allows that via a full factory reset — so we say so rather than
     * attempting something that would fail or half-work.
     */
    private fun remoteUninstall(): Pair<String, String> {
        if (policy.isDeviceOwner()) {
            return "failed" to "cannot self-uninstall as Device Owner — Android requires a factory reset to remove a fully-managed device"
        }
        if (policy.isAdminActive()) {
            runCatching {
                (context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager)
                    .removeActiveAdmin(com.sentroid.agent.admin.SentroidDeviceAdminReceiver.componentName(context))
            }
        }
        prefs.clearEnrollment()
        return try {
            val intent = Intent(Intent.ACTION_DELETE, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            "completed" to "device admin removed and local data cleared; uninstall prompt shown on-device (one tap to confirm — Android does not allow a fully silent uninstall)"
        } catch (e: Exception) {
            "failed" to "device admin removed but could not open uninstall prompt: ${e.message}"
        }
    }

    /**
     * Post a tappable notification asking the user to grant location access.
     * A LOCATE that fails for want of a permission is otherwise invisible on
     * the device — the operator sees a failure and the user never learns there
     * was anything to approve.
     */
    private fun promptForLocationPermission() {
        val intent = Intent(
            android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        notify(
            NOTIF_LOCATION_PERMISSION,
            "Location permission needed",
            "SENTROID was asked to locate this device but has no location access. Tap to grant it.",
            intent,
        )
    }

    /** Prompt the user to switch the OS location toggle back on. */
    private fun promptToEnableLocationServices() {
        val intent = Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        notify(
            NOTIF_LOCATION_SERVICES,
            "Turn on location",
            "SENTROID was asked to locate this device but location services are off. Tap to turn them on.",
            intent,
        )
    }

    private fun notify(id: Int, title: String, text: String, intent: Intent) {
        runCatching {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O &&
                nm.getNotificationChannel(ACTION_CHANNEL_ID) == null
            ) {
                // Matches the service's own channel definition — creating it
                // again with different settings would be ignored by Android
                // anyway once the channel exists.
                nm.createNotificationChannel(
                    android.app.NotificationChannel(
                        ACTION_CHANNEL_ID,
                        "SENTROID Remote Actions",
                        android.app.NotificationManager.IMPORTANCE_HIGH,
                    ).apply {
                        description = "Remote administrator actions executed on this device"
                        setSound(null, null)
                        enableVibration(false)
                    },
                )
            }
            val flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT or
                android.app.PendingIntent.FLAG_IMMUTABLE
            val pi = android.app.PendingIntent.getActivity(context, id, intent, flags)
            val n = androidx.core.app.NotificationCompat.Builder(context, ACTION_CHANNEL_ID)
                .setSmallIcon(com.sentroid.agent.R.drawable.ic_shield)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            nm.notify(id, n)
        }
    }

    /** Play the default ringtone at max volume for a few seconds to locate the device. */
    private fun ring(): String {
        var ringtone: android.media.Ringtone? = null
        return try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val prev = try { am.getStreamVolume(AudioManager.STREAM_ALARM) } catch (e: Exception) { -1 }
            // Raising the volume can be blocked by Do-Not-Disturb policy on some
            // devices; ring at the current volume rather than failing.
            try {
                am.setStreamVolume(
                    AudioManager.STREAM_ALARM,
                    am.getStreamMaxVolume(AudioManager.STREAM_ALARM),
                    0,
                )
            } catch (_: Exception) {
            }
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                ?: return "ring: no ringtone available"
            ringtone = RingtoneManager.getRingtone(context, uri) ?: return "ring: no ringtone available"
            val rt = ringtone
            // Bind playback to the ALARM stream/usage explicitly — a Ringtone's
            // default audio attributes target the ring/notification stream, not
            // the one we just boosted above, and alarm-category audio is also
            // the one most likely to bypass silent/DND modes so the device is
            // actually locatable. (minSdk 24, so AudioAttributes is always available.)
            rt.audioAttributes = android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            rt.play()
            Handler(Looper.getMainLooper()).postDelayed({
                try { if (rt.isPlaying) rt.stop() } catch (_: Exception) {}
                if (prev >= 0) try { am.setStreamVolume(AudioManager.STREAM_ALARM, prev, 0) } catch (_: Exception) {}
            }, 5000)
            "ringing for 5s"
        } catch (e: Exception) {
            try { ringtone?.stop() } catch (_: Exception) {}
            "ring failed: ${e.message}"
        }
    }

    private companion object {
        /** Same channel the service uses for remote-action notifications. */
        const val ACTION_CHANNEL_ID = "sentroid_actions_v2"
        const val NOTIF_LOCATION_PERMISSION = 2001
        const val NOTIF_LOCATION_SERVICES = 2002
    }
}
