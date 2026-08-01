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

    var lastPolicyJson: String?
        get() = sp.getString(KEY_POLICY, null)
        set(v) = sp.edit().putString(KEY_POLICY, v).apply()

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
            .putBoolean(KEY_DISABLED, false)
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
    }
}
