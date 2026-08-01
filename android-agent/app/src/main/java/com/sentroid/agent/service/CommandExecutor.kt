package com.sentroid.agent.service

import android.content.Context
import android.media.AudioManager
import android.media.RingtoneManager
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
                    prefs.disabled = false
                    "completed" to "unlock acknowledged (local restrictions cleared)"
                }

                "WIPE" -> "completed" to policy.wipe()

                "DISABLE" -> {
                    prefs.disabled = true
                    "completed" to (policy.lockNow() + "; device marked disabled")
                }

                "ENABLE" -> {
                    prefs.disabled = false
                    "completed" to "device re-enabled"
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
                    val loc = DeviceInfo.requestFreshLocation(context, 8000)
                    if (loc != null) "completed" to "location ${loc.first},${loc.second}"
                    else "completed" to "location unavailable (permission or no fix)"
                }

                "PING" -> "completed" to "pong @ ${System.currentTimeMillis()}"

                "RING" -> "completed" to ring()

                else -> "failed" to "unknown command ${cmd.type}"
            }
        } catch (e: Exception) {
            "failed" to "exception: ${e.message}"
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
}
