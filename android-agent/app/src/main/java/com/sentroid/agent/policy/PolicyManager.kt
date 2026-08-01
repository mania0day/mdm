package com.sentroid.agent.policy

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import com.sentroid.agent.admin.SentroidDeviceAdminReceiver
import org.json.JSONObject

/**
 * Translates a server policy document into real DevicePolicyManager enforcement,
 * and executes the remote commands. Every action here requires SENTROID to be an
 * active device administrator. (Proposal 5.3 Policy Enforcement / 6 Core Functionalities)
 */
class PolicyManager(private val context: Context) {

    private val dpm: DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private val admin: ComponentName = SentroidDeviceAdminReceiver.componentName(context)

    fun isAdminActive(): Boolean = dpm.isAdminActive(admin)

    /**
     * As Device Owner, auto-grant the location permissions the agent needs for
     * 24/7 tracking (fine, coarse, and background) so no user interaction is
     * required and backgrounded location requests are never denied.
     */
    fun grantLocationPermissions() {
        if (!dpm.isDeviceOwnerApp(context.packageName)) return
        val pkg = context.packageName
        val perms = mutableListOf(
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            perms.add(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
        for (p in perms) {
            runCatching {
                dpm.setPermissionGrantState(
                    admin, pkg, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                )
            }
        }
    }

    /** Apply a policy JSON (min password length, camera, failed-attempt wipe, etc.). */
    fun applyPolicy(policy: JSONObject): String {
        if (!isAdminActive()) return "skipped: device admin not active"
        val applied = StringBuilder()
        val restricted = StringBuilder()

        // Each restriction is applied independently: several DevicePolicyManager
        // controls (password quality, camera, screen-timeout) require Device Owner
        // / Profile Owner provisioning on Android 12+, and throw for a plain device
        // admin. We record which applied and which need Device Owner, rather than
        // aborting the whole policy on the first restriction.
        fun tryApply(label: String, block: () -> Unit) {
            try {
                block()
                applied.append("$label ")
            } catch (e: Exception) {
                // These policies (password quality, camera) require Device Owner /
                // Profile Owner provisioning; a plain Device Admin cannot apply them.
                android.util.Log.w("SentroidPolicy", "restriction '$label' requires Device Owner", e)
                restricted.append("$label ")
            }
        }

        val quality = policy.optString("password_quality", "numeric")
        val minLen = policy.optInt("min_password_length", 6)
        val qualityConst = when (quality) {
            "none" -> DevicePolicyManager.PASSWORD_QUALITY_UNSPECIFIED
            "numeric" -> DevicePolicyManager.PASSWORD_QUALITY_NUMERIC
            "alphanumeric" -> DevicePolicyManager.PASSWORD_QUALITY_ALPHANUMERIC
            "complex" -> DevicePolicyManager.PASSWORD_QUALITY_COMPLEX
            else -> DevicePolicyManager.PASSWORD_QUALITY_NUMERIC
        }
        tryApply("password[$quality,>=$minLen]") {
            dpm.setPasswordQuality(admin, qualityConst)
            dpm.setPasswordMinimumLength(admin, minLen)
        }
        val maxFailed = policy.optInt("max_failed_passwords", 0)
        if (maxFailed > 0) tryApply("wipeAfter=$maxFailed") {
            dpm.setMaximumFailedPasswordsForWipe(admin, maxFailed)
        }
        val timeoutSec = policy.optInt("max_screen_timeout_seconds", 0)
        if (timeoutSec > 0) tryApply("maxLock=${timeoutSec}s") {
            dpm.setMaximumTimeToLock(admin, timeoutSec * 1000L)
        }
        val disableCam = policy.optBoolean("disable_camera", false)
        tryApply("camera=${if (disableCam) "disabled" else "enabled"}") {
            dpm.setCameraDisabled(admin, disableCam)
        }
        // As Device Owner, silently grant the location permissions the agent needs
        // so the admin can always locate the device — including while it is idle in
        // the background (ACCESS_BACKGROUND_LOCATION). Without this, backgrounded
        // location requests are denied and LOCATE returns "unavailable".
        tryApply("location-perms") { grantLocationPermissions() }

        // Force location services ON and block the user from disabling them, so
        // live tracking is always available (Device Owner only).
        val forceLoc = policy.optBoolean("force_location_on", false)
        tryApply("location=${if (forceLoc) "forced-on" else "user-controlled"}") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && dpm.isDeviceOwnerApp(context.packageName)) {
                if (forceLoc) {
                    dpm.setLocationEnabled(admin, true)
                    dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_LOCATION)
                } else {
                    dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_LOCATION)
                }
            } else {
                throw SecurityException("requires Device Owner")
            }
        }

        val result = StringBuilder()
        if (applied.isNotEmpty()) result.append("applied: ${applied.toString().trim()}")
        if (restricted.isNotEmpty()) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append("requires Device Owner: ${restricted.toString().trim()}")
        }
        return result.toString().ifEmpty { "no policy changes" }
    }

    /** Immediately lock the device screen. */
    fun lockNow(): String {
        if (!isAdminActive()) return "failed: device admin not active"
        dpm.lockNow()
        return "device locked"
    }

    /**
     * Factory-reset / wipe the device via the Device Owner API. On real hardware
     * the device wipes immediately and goes permanently offline (so a "completed"
     * result is typically never delivered — the device disappearing is the real
     * confirmation). Some emulator images cannot perform the recovery reboot and
     * fail this at the OS level; we report honestly rather than claiming success.
     * Requires the wipe-data policy in device_admin.xml.
     */
    fun wipe(): String {
        if (!isAdminActive()) return "failed: device admin not active"
        return try {
            dpm.wipeData(0)
            "factory wipe requested via Device Owner (device will reset & go offline)"
        } catch (e: Exception) {
            "failed: ${e.message}"
        }
    }

    /**
     * Set (reset) a new lock-screen password. The legacy resetPassword() is
     * blocked for device admins on Android 8+, so when provisioned as Device
     * Owner we use the modern reset-password-token flow.
     */
    fun resetPassword(newPassword: String): String {
        if (!isAdminActive()) return "failed: device admin not active"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                dpm.isDeviceOwnerApp(context.packageName)
            ) {
                val token = ByteArray(32)
                java.security.SecureRandom().nextBytes(token)
                val set = dpm.setResetPasswordToken(admin, token)
                if (set && dpm.isResetPasswordTokenActive(admin)) {
                    val ok = dpm.resetPasswordWithToken(admin, newPassword, token, 0)
                    if (ok) "lock password reset (via token)" else "reset failed"
                } else {
                    "reset token registered; needs one credential entry to activate"
                }
            } else {
                @Suppress("DEPRECATION")
                val ok = dpm.resetPassword(newPassword, DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY)
                if (ok) "password reset" else "requires Device Owner provisioning"
            }
        } catch (e: SecurityException) {
            "reset requires Device Owner: ${e.message?.take(40)}"
        } catch (e: Exception) {
            "reset error: ${e.message?.take(40)}"
        }
    }

    fun setCameraDisabled(disabled: Boolean): String {
        if (!isAdminActive()) return "failed: device admin not active"
        dpm.setCameraDisabled(admin, disabled)
        return if (disabled) "camera disabled" else "camera enabled"
    }
}
