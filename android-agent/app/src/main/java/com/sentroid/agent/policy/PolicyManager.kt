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

    /** Whether this app was provisioned as Device Owner (full fleet-management mode). */
    fun isDeviceOwner(): Boolean = dpm.isDeviceOwnerApp(context.packageName)

    /**
     * As Device Owner, auto-grant the location permissions the agent needs for
     * 24/7 tracking (fine, coarse, and background) so no user interaction is
     * required and backgrounded location requests are never denied.
     */
    fun grantLocationPermissions() {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            // Signal "not applied" up to applyPolicy()'s tryApply(), rather
            // than silently no-op'ing and letting the caller believe the
            // grant succeeded when it didn't run at all.
            throw SecurityException("requires Device Owner")
        }
        val pkg = context.packageName
        val perms = mutableListOf(
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
            // Needed for the fleet-inventory scan (build/serial/IMEI reads);
            // Device Owner can silently grant it — no user prompt required.
            android.Manifest.permission.READ_PHONE_STATE,
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

    /**
     * Cement SENTROID as un-removable, always-on organization property — the
     * phone belongs to the org, so the employee cannot take the agent off it.
     *
     * Being Device Owner already prevents the user from uninstalling the app or
     * deactivating its admin; these two calls close the remaining escape routes
     * so the agent behaves like a resident system service:
     *  - setUninstallBlocked(self): belt-and-suspenders against uninstall, and
     *    it also blocks uninstall via `adb`/PackageInstaller, not just the UI.
     *  - setUserControlDisabledPackages (Android 11 / API 30+): removes the
     *    "Force stop" and "Clear storage" buttons in Settings, so the user
     *    cannot kill the check-in service or wipe the agent's state. No API for
     *    this exists below 30, so on Android 10 it is a documented best-effort
     *    (the foreground service + BootReceiver + crash-restart still keep it up).
     *
     * Device Owner only — a plain Device Admin cannot do either, and applyPolicy
     * reports it as "requires Device Owner" rather than faking success. The only
     * way off the device remains the server-issued WIPE (factory reset).
     */
    fun enforceOwnership(): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            throw SecurityException("requires Device Owner")
        }
        val pkg = context.packageName
        dpm.setUninstallBlocked(admin, pkg, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            dpm.setUserControlDisabledPackages(admin, listOf(pkg))
            return "ownership locked (uninstall + force-stop blocked)"
        }
        return "ownership locked (uninstall blocked; force-stop block needs Android 11+)"
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

        // Cement organization ownership FIRST, before any other policy: make the
        // agent un-uninstallable and un-force-stoppable so it stays resident like
        // a system service on this org-owned device. Re-asserted on every policy
        // apply (i.e. every check-in) for continuous enforcement, and reported as
        // "requires Device Owner" on a plain Device Admin instead of faking it.
        tryApply("ownership-lock") { enforceOwnership() }

        // Arm lock-screen recovery as early as possible — ideally at enrollment,
        // while IT still holds the unlocked device. A reset token can only be
        // activated by the user unlocking once, which is impossible after they
        // are locked out, so registering it late means no recovery at all and a
        // wipe as the only way back in. No-op once a token is stored.
        tryApply("recovery-token") { ensureResetPasswordToken() }

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

        // Microphone block: Android has no per-app "disable mic" DPM call —
        // the real mechanism is a system-wide user restriction that mutes and
        // locks the mic, which (like camera/password/location) only a Device
        // Owner can set. A plain Device Admin throws here, same as the others.
        val disableMic = policy.optBoolean("disable_mic", false)
        tryApply("mic=${if (disableMic) "disabled" else "enabled"}") {
            if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
            if (disableMic) {
                dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_UNMUTE_MICROPHONE)
            } else {
                dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_UNMUTE_MICROPHONE)
            }
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

        // Keep airplane mode OFF and block the user from turning it back on, so
        // a managed device can't be deliberately taken off the network. Same
        // DISALLOW_AIRPLANE_MODE mechanism as the AIRPLANE_MODE_OFF command, but
        // re-asserted here on every policy apply (i.e. every check-in) so it is
        // continuously enforced rather than a one-shot toggle. Device Owner +
        // Android 9 (P) only; a plain Device Admin reports it as unenforceable.
        val blockAirplane = policy.optBoolean("force_airplane_mode_off", false)
        tryApply("airplane=${if (blockAirplane) "blocked-off" else "user-controlled"}") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && dpm.isDeviceOwnerApp(context.packageName)) {
                if (blockAirplane) {
                    dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                } else {
                    dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                }
            } else {
                throw SecurityException("requires Device Owner")
            }
        }

        // Availability lockdown (Device Owner only) — keep a managed device online
        // and under control by blocking the OS routes normally used to take it off
        // management: a Safe-Mode reboot (Safe Mode disables the device admin), a
        // factory reset from Settings, and adding a secondary/guest user outside the
        // managed profile. Android exposes no API to block a hardware power-off, so
        // these cover the routes that CAN be enforced. Re-asserted on every policy
        // apply (i.e. every check-in) so they're continuously enforced, and reported
        // as "requires Device Owner" on a plain Device Admin instead of silently
        // no-op'ing. (Proposal 5.3 Policy Enforcement)
        val noSafeBoot = policy.optBoolean("disallow_safe_boot", false)
        tryApply("safeBoot=${if (noSafeBoot) "blocked" else "allowed"}") {
            if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
            if (noSafeBoot) dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_SAFE_BOOT)
            else dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_SAFE_BOOT)
        }
        val noFactoryReset = policy.optBoolean("disallow_factory_reset", false)
        tryApply("factoryReset=${if (noFactoryReset) "blocked" else "allowed"}") {
            if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
            if (noFactoryReset) dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_FACTORY_RESET)
            else dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_FACTORY_RESET)
        }
        val noAddUser = policy.optBoolean("disallow_add_user", false)
        tryApply("addUser=${if (noAddUser) "blocked" else "allowed"}") {
            if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
            if (noAddUser) dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_ADD_USER)
            else dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_ADD_USER)
        }

        val result = StringBuilder()
        if (applied.isNotEmpty()) result.append("applied: ${applied.toString().trim()}")
        if (restricted.isNotEmpty()) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append("requires Device Owner: ${restricted.toString().trim()}")
        }
        return result.toString().ifEmpty { "no policy changes" }
    }

    /**
     * Turn the OS location toggle on or off remotely.
     *
     * Android gates this hard, and the capability differs by API level:
     *  - Device Owner on Android 11+ : setLocationEnabled() does exactly this.
     *  - Device Owner on Android 9/10: there is no API to switch location ON.
     *    Location can only be forced OFF, via the DISALLOW_SHARE_LOCATION user
     *    restriction. Clearing that restriction permits location again but
     *    cannot re-enable it, so turning it back on stays a user action.
     *  - Plain Device Admin          : not possible at any API level.
     *
     * Each case reports what actually happened rather than claiming success.
     */
    fun setLocationEnabled(enabled: Boolean): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            return "location unchanged: requires Device Owner (this device is Device Admin only)"
        }
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                dpm.setLocationEnabled(admin, enabled)
                if (enabled) {
                    dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_LOCATION)
                    "location turned ON and locked so the user cannot disable it"
                } else {
                    dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_LOCATION)
                    "location turned OFF"
                }
            } else {
                if (enabled) {
                    dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_SHARE_LOCATION)
                    "location permitted again, but Android ${Build.VERSION.RELEASE} has no API to switch it on remotely — the user must enable it (they have been prompted on-device)"
                } else {
                    dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_SHARE_LOCATION)
                    "location forced OFF and blocked"
                }
            }
        } catch (e: Exception) {
            "location unchanged: ${e.message?.take(60)}"
        }
    }

    /**
     * Turn airplane mode off and stop the user from switching it back on.
     *
     * DISALLOW_AIRPLANE_MODE is Device Owner–only and needs Android 9+. Adding
     * it switches airplane mode off immediately as a side effect, which is what
     * makes "disable airplane mode from the server" possible at all — there is
     * no API that toggles airplane mode directly for a non-system app, so
     * blocking it is the only supported route.
     */
    fun setAirplaneModeBlocked(blocked: Boolean): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            return "airplane mode unchanged: requires Device Owner (this device is Device Admin only)"
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return "airplane mode unchanged: requires Android 9+ (device runs ${Build.VERSION.RELEASE})"
        }
        return try {
            if (blocked) {
                dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                "airplane mode turned OFF and blocked — the user cannot re-enable it"
            } else {
                dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                "airplane mode unblocked — the user may toggle it again"
            }
        } catch (e: Exception) {
            "airplane mode unchanged: ${e.message?.take(60)}"
        }
    }

    /**
     * Block (or restore) the status bar / notification shade — the real
     * difference between DISABLE and a plain one-time LOCK. Without this,
     * "disabled" is just "gets re-locked every ~10-30s," but the user can
     * still pull down quick settings, flashlight, Wi-Fi toggle, etc. between
     * cycles. setStatusBarDisabled is a Device Owner–only API; on a plain
     * Device Admin this throws and DISABLE falls back to repeated re-lock
     * only, which is reported honestly in the command result.
     */
    fun setStatusBarBlocked(blocked: Boolean): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            return "status bar unchanged: requires Device Owner"
        }
        return try {
            dpm.setStatusBarDisabled(admin, blocked)
            if (blocked) "status bar blocked" else "status bar restored"
        } catch (e: Exception) {
            "status bar unchanged: ${e.message?.take(40)}"
        }
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
     * Restart (reboot) the device. This is the ONLY remote power control Android
     * offers — there is no API to power a device OFF, even for a Device Owner —
     * so the server's "Restart" maps here. dpm.reboot() is Device Owner–only
     * (API 24+) and the OS refuses it while a phone call is in progress; we
     * report each case honestly instead of a blind failure.
     *
     * Note: on success the device reboots immediately, so the "completed" result
     * usually never reaches the server — the device dropping offline and then
     * checking back in is the real confirmation, exactly like WIPE.
     */
    fun reboot(): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            return "restart unavailable: requires Device Owner (this device is Device Admin only)"
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return "restart unavailable: requires Android 7+ (device runs ${Build.VERSION.RELEASE})"
        }
        return try {
            dpm.reboot(admin)
            "restart requested — device is rebooting"
        } catch (e: IllegalStateException) {
            "restart deferred: a phone call is in progress (Android blocks reboot mid-call)"
        } catch (e: Exception) {
            "restart failed: ${e.message?.take(60)}"
        }
    }

    /**
     * Arm lock-screen recovery: register a reset-password token ONCE and keep it.
     *
     * This is what makes "the employee is locked out — unlock the phone without
     * losing their data" possible. Android will only let a Device Owner change an
     * EXISTING lock screen if it presents a token that was registered beforehand
     * and then activated by the user entering their credential once. Activation
     * cannot happen while somebody is already locked out, so the token has to be
     * put in place early — at enrollment, while IT still has the unlocked device
     * — and persisted (Prefs.resetPasswordToken) for the life of the enrollment.
     *
     * Called on every policy apply, but only *registers* when no token is stored:
     * calling setResetPasswordToken again would replace the token and silently
     * de-activate recovery, which is exactly the failure mode this guards against.
     *
     * Returns the recovery state so the console can show whether this device is
     * actually recoverable yet, instead of finding out only when it's too late.
     */
    fun ensureResetPasswordToken(): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            throw SecurityException("requires Device Owner")
        }
        val prefs = com.sentroid.agent.data.Prefs(context)
        if (prefs.resetPasswordToken == null) {
            val bytes = ByteArray(32)
            java.security.SecureRandom().nextBytes(bytes)
            // Can legitimately fail on devices without the secure hardware this
            // needs; report rather than pretend recovery is available.
            if (!dpm.setResetPasswordToken(admin, bytes)) {
                return "recovery unavailable (device rejected the reset token)"
            }
            prefs.resetPasswordToken = bytes
        }
        return if (dpm.isResetPasswordTokenActive(admin)) {
            "recovery armed"
        } else {
            "recovery pending — user must unlock the device once to activate it"
        }
    }

    /** Whether a remote unlock would actually work on this device right now. */
    fun isRecoveryArmed(): Boolean = runCatching {
        dpm.isDeviceOwnerApp(context.packageName) &&
            com.sentroid.agent.data.Prefs(context).resetPasswordToken != null &&
            dpm.isResetPasswordTokenActive(admin)
    }.getOrDefault(false)

    /**
     * Set a new lock-screen password — the remote-unlock path for a locked-out
     * employee. Uses the PERSISTED token from ensureResetPasswordToken(), which
     * is the whole point: the device keeps all its data and simply gets a new
     * PIN the admin can read off the console and pass to the user.
     *
     * The legacy resetPassword() is blocked for device admins on Android 8+, so
     * a plain Device Admin genuinely cannot do this and is told so.
     */
    fun resetPassword(newPassword: String): String {
        if (!isAdminActive()) return "failed: device admin not active"
        return try {
            if (!dpm.isDeviceOwnerApp(context.packageName)) {
                return "unlock requires Device Owner — Android 8+ blocks a plain Device Admin from changing an existing lock screen"
            }
            // Make sure a token exists (no-op if one was already armed at enrollment).
            val state = ensureResetPasswordToken()
            val stored = com.sentroid.agent.data.Prefs(context).resetPasswordToken
                ?: return "unlock unavailable: $state"
            if (!dpm.isResetPasswordTokenActive(admin)) {
                // The honest, actionable case: recovery was never activated, so
                // there is no way in without a wipe. Say exactly what to do.
                return "unlock unavailable: $state. Recovery must be armed BEFORE a lockout — " +
                    "have the user unlock the device once while enrolled, then this will work."
            }
            val ok = dpm.resetPasswordWithToken(admin, newPassword, stored, 0)
            if (ok) {
                "lock screen reset to the new PIN — all data preserved, no factory reset"
            } else {
                "reset rejected by the device (the new PIN may not meet the enforced password policy)"
            }
        } catch (e: SecurityException) {
            "reset requires Device Owner: ${e.message?.take(60)}"
        } catch (e: Exception) {
            "reset error: ${e.message?.take(60)}"
        }
    }

    fun setCameraDisabled(disabled: Boolean): String {
        if (!isAdminActive()) return "failed: device admin not active"
        dpm.setCameraDisabled(admin, disabled)
        return if (disabled) "camera disabled" else "camera enabled"
    }
}
