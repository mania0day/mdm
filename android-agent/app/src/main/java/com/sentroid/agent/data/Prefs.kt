package com.sentroid.agent.data

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * Lightweight persistent store for the agent's enrollment state and settings.
 * (Backed by SharedPreferences; in a production build this would be encrypted.)
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences("sentroid", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(KEY_SERVER, "") ?: ""
        set(v) = sp.edit().putString(KEY_SERVER, v.trimEnd('/')).apply()

    var deviceToken: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(v) = sp.edit().putString(KEY_TOKEN, v).apply()

    var deviceId: Int
        get() = sp.getInt(KEY_DEVICE_ID, -1)
        set(v) = sp.edit().putInt(KEY_DEVICE_ID, v).apply()

    // A stable per-install identifier used as the device UID during enrollment.
    val deviceUid: String
        get() {
            var uid = sp.getString(KEY_UID, null)
            if (uid == null) {
                uid = "sentroid-" + UUID.randomUUID().toString().substring(0, 12)
                sp.edit().putString(KEY_UID, uid).apply()
            }
            return uid
        }

    var checkinInterval: Int
        get() = sp.getInt(KEY_INTERVAL, 10)
        set(v) = sp.edit().putInt(KEY_INTERVAL, v).apply()

    // Local "disabled" flag: when set, the agent keeps the device locked.
    var disabled: Boolean
        get() = sp.getBoolean(KEY_DISABLED, false)
        set(v) = sp.edit().putBoolean(KEY_DISABLED, v).apply()

    // Server-gated permission to show the on-device technical setup screen.
    // Defaults to false: a normal employee never sees device internals
    // unless an admin explicitly unlocks it from the console.
    var allowReconfigure: Boolean
        get() = sp.getBoolean(KEY_ALLOW_RECONFIGURE, false)
        set(v) = sp.edit().putBoolean(KEY_ALLOW_RECONFIGURE, v).apply()

    var lastPolicyJson: String?
        get() = sp.getString(KEY_POLICY, null)
        set(v) = sp.edit().putString(KEY_POLICY, v).apply()

    // Identity set by the admin at token-issue time (server is the source of
    // truth; the device never types this in). Shown on-screen instead of the
    // technical device internals, per the "monitor only, minimal on-screen
    // info" requirement — no other PII is displayed on the device itself.
    var ownerName: String?
        get() = sp.getString(KEY_OWNER_NAME, null)
        set(v) = sp.edit().putString(KEY_OWNER_NAME, v).apply()

    var employeeId: String?
        get() = sp.getString(KEY_EMPLOYEE_ID, null)
        set(v) = sp.edit().putString(KEY_EMPLOYEE_ID, v).apply()

    // Most recent compliance verdict from a check-in ("compliant" / "non_compliant").
    var lastCompliance: String?
        get() = sp.getString(KEY_COMPLIANCE, null)
        set(v) = sp.edit().putString(KEY_COMPLIANCE, v).apply()

    /**
     * Reasons behind the latest non-compliant verdict, newline-separated, so the
     * device can explain "Needs attention" rather than just asserting it.
     */
    var lastViolations: List<String>
        get() = sp.getString(KEY_VIOLATIONS, null)
            ?.split('\n')
            ?.filter { it.isNotBlank() }
            ?: emptyList()
        set(v) = sp.edit().putString(KEY_VIOLATIONS, v.joinToString("\n")).apply()

    // Best dino-runner score seen on this install — shown in-game immediately,
    // independent of whether the server sync succeeds.
    var localHighScore: Int
        get() = sp.getInt(KEY_HIGH_SCORE, 0)
        set(v) = sp.edit().putInt(KEY_HIGH_SCORE, v).apply()

    // Enrollment token captured during QR/zero-touch provisioning, consumed by the
    // service to auto-enroll as soon as the network is available.
    var pendingEnrollToken: String?
        get() = sp.getString(KEY_PENDING_TOKEN, null)
        set(v) = sp.edit().putString(KEY_PENDING_TOKEN, v).apply()

    val isEnrolled: Boolean
        get() = !deviceToken.isNullOrEmpty()

    fun clearEnrollment() {
        sp.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_DEVICE_ID)
            .remove(KEY_POLICY)
            .remove(KEY_OWNER_NAME)
            .remove(KEY_EMPLOYEE_ID)
            .remove(KEY_COMPLIANCE)
            .remove(KEY_VIOLATIONS)
            .putBoolean(KEY_DISABLED, false)
            .putBoolean(KEY_ALLOW_RECONFIGURE, false)
            .apply()
    }

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_UID = "device_uid"
        private const val KEY_INTERVAL = "checkin_interval"
        private const val KEY_DISABLED = "disabled"
        private const val KEY_POLICY = "policy_json"
        private const val KEY_PENDING_TOKEN = "pending_enroll_token"
        private const val KEY_OWNER_NAME = "owner_name"
        private const val KEY_EMPLOYEE_ID = "employee_id"
        private const val KEY_COMPLIANCE = "last_compliance"
        private const val KEY_VIOLATIONS = "last_violations"
        private const val KEY_ALLOW_RECONFIGURE = "allow_reconfigure"
        private const val KEY_HIGH_SCORE = "local_high_score"
    }
}
