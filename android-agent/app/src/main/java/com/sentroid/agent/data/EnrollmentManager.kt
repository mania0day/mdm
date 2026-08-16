package com.sentroid.agent.data

import android.content.Context
import com.sentroid.agent.policy.PolicyManager
import com.sentroid.agent.util.DeviceInfo
import org.json.JSONObject

/**
 * Single source of truth for enrolling this device against the SENTROID server.
 * Used by both the manual enrollment UI (MainActivity) and the automatic
 * QR / zero-touch provisioning flow. Must be called off the main thread.
 */
object EnrollmentManager {

    /** Enroll against [server] with [token]. Returns null on success, else an error. */
    fun enroll(context: Context, server: String, token: String): String? {
        return try {
            val prefs = Prefs(context)
            val body = JSONObject()
                .put("enrollment_token", token)
                .put("device_uid", prefs.deviceUid)
                .put("name", "${DeviceInfo.manufacturer()} ${DeviceInfo.model()}")
                .put("manufacturer", DeviceInfo.manufacturer())
                .put("model", DeviceInfo.model())
                .put("os_version", DeviceInfo.osVersion())
                .put("sdk_int", DeviceInfo.sdkInt())
                .put("serial", DeviceInfo.serial())
                .put("build_fingerprint", DeviceInfo.buildFingerprint())
                .put("security_patch", DeviceInfo.securityPatch())
                .put("management_mode", DeviceInfo.managementMode(context))
                .put("is_rooted", DeviceInfo.isRooted(context))
            DeviceInfo.imei(context)?.let { body.put("imei", it) }
            DeviceInfo.phoneNumber(context)?.let { body.put("phone_number", it) }
            DeviceInfo.simOperator(context)?.let { body.put("sim_operator", it) }
            val res = ApiClient(server).enroll(body)
            prefs.serverUrl = server
            prefs.deviceToken = res.getString("device_token")
            prefs.deviceId = res.getInt("device_id")
            prefs.ownerName = res.optString("owner_name", "").ifBlank { null }
            prefs.employeeId = res.optString("employee_id", "").ifBlank { null }
            res.optJSONObject("policy")?.optJSONObject("config")?.let {
                prefs.lastPolicyJson = it.toString()
                PolicyManager(context).applyPolicy(it)
            }
            null
        } catch (e: Exception) {
            e.message ?: "enrollment failed"
        }
    }
}
