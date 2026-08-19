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
        // A third bucket, deliberately separate from `restricted`: a few rules go
        // unenforced because this Android version has no API for them at all,
        // which is a different answer from "needs Device Owner" — re-provisioning
        // the handset would fix the second and would change nothing about the
        // first. Folding them together would send an operator chasing a fix that
        // cannot exist on that device.
        val unenforceable = StringBuilder()
        // A fourth bucket, for the case where the handset IS provisioned correctly
        // and the platform refused the VALUE rather than the caller (an SSID whose
        // UTF-8 form is not 1-32 bytes is the realistic one). Re-provisioning the
        // device fixes nothing here — editing the policy in the console does — so
        // it must never be reported as a Device Owner problem.
        val rejected = StringBuilder()
        // A fifth bucket, for rules switched to 'monitor' that this agent has no
        // detector for. They really are unblocked below, but nothing records the
        // breach, so an empty Violations tab would read as "nobody did this" when
        // it means "nobody was looking". Naming the gap is the only honest option:
        // silently keeping the rule enforced would be the opposite lie.
        val undetectable = StringBuilder()

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

        // The other half of 'monitor' — the half this agent cannot always deliver.
        // Unblocking is only half the contract; the breach still has to be
        // reported, and ViolationMonitor implements a detector for the rules in
        // DETECTED_RULES and no others. For anything else 'monitor' means
        // unblocked AND unrecorded, so the rule is named in `undetectable` instead
        // of being left to read as coverage. Only worth saying when the rule is
        // actually switched on: 'monitor' on a rule set to false asks for nothing.
        fun noteWatchGap(label: String, rule: String, mode: String) {
            if (mode == MODE_MONITOR && rule !in DETECTED_RULES && policy.optBoolean(rule, false)) {
                undetectable.append("$label ")
            }
        }

        // One boolean user-restriction rule, applied under its per-rule mode.
        //
        // The mode is what decides whether the OS blocks: only 'enforce' can turn
        // a restriction ON. 'monitor' and 'off' actively turn it OFF rather than
        // merely skipping it, because a restriction added by yesterday's policy is
        // still latched into the OS today — and a "monitored" rule the handset
        // quietly keeps blocking can never produce the breach the console is
        // waiting for, so the Violations tab would sit empty and read as "nobody
        // ever did this". Detection for monitored rules lives in the breach
        // detector, not here; this method's only job is to get out of its way.
        fun tryRestriction(label: String, rule: String, restriction: String) {
            val mode = ruleMode(policy, rule)
            val block = mode == MODE_ENFORCE && policy.optBoolean(rule, false)
            noteWatchGap(label, rule, mode)
            tryApply("$label=${if (block) "blocked" else "allowed"}${modeNote(mode)}") {
                applyRestriction(restriction, block)
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
        // Camera and microphone run through the same per-rule mode gate as the
        // corporate controls below: both are named in POLICY_SCHEMA.rule_modes,
        // so honouring only their boolean would silently keep blocking a rule an
        // operator had switched to 'monitor' — the hardware would stay dead while
        // the console promised it was merely being watched.
        val camMode = ruleMode(policy, "disable_camera")
        val disableCam = camMode == MODE_ENFORCE && policy.optBoolean("disable_camera", false)
        noteWatchGap("camera", "disable_camera", camMode)
        tryApply("camera=${if (disableCam) "disabled" else "enabled"}${modeNote(camMode)}") {
            dpm.setCameraDisabled(admin, disableCam)
        }

        // Microphone block: Android has no per-app "disable mic" DPM call —
        // the real mechanism is a system-wide user restriction that mutes and
        // locks the mic, which (like camera/password/location) only a Device
        // Owner can set. A plain Device Admin throws here, same as the others.
        val micMode = ruleMode(policy, "disable_mic")
        val disableMic = micMode == MODE_ENFORCE && policy.optBoolean("disable_mic", false)
        noteWatchGap("mic", "disable_mic", micMode)
        tryApply("mic=${if (disableMic) "disabled" else "enabled"}${modeNote(micMode)}") {
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
        // Mode-gated like camera and mic: 'monitor' must genuinely let the user
        // toggle airplane mode, otherwise the breach the console is waiting to
        // record can never happen.
        val airplaneMode = ruleMode(policy, "force_airplane_mode_off")
        val blockAirplane =
            airplaneMode == MODE_ENFORCE && policy.optBoolean("force_airplane_mode_off", false)
        noteWatchGap("airplane", "force_airplane_mode_off", airplaneMode)
        tryApply("airplane=${if (blockAirplane) "blocked-off" else "user-controlled"}${modeNote(airplaneMode)}") {
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

        // --- Corporate controls (block-or-watch) ------------------------------
        // Every rule below is gated on its entry in the policy's rule_modes object
        // (POLICY_SCHEMA / ruleMode() in the server's policyEngine.js). Only
        // 'enforce' reaches DevicePolicyManager here; see tryRestriction above for
        // why 'monitor' and 'off' clear rather than skip.

        // Company phone, company rules. DISALLOW_OUTGOING_CALLS stops the dialer
        // placing calls; emergency numbers stay dialable no matter what a policy
        // says — Android never lets an admin block them, and SENTROID does not
        // pretend to. Device Owner only, like every restriction in this section.
        tryRestriction("calls", "block_outgoing_calls", android.os.UserManager.DISALLOW_OUTGOING_CALLS)

        // Nothing gets installed that IT did not approve. DISALLOW_INSTALL_APPS
        // covers the user-facing install routes — Play Store, a browser download,
        // any PackageInstaller session — not just sideloading, which is the
        // narrower unknown-sources rule below.
        tryRestriction("appInstalls", "block_new_app_installs", android.os.UserManager.DISALLOW_INSTALL_APPS)

        // Sideloading ("install unknown apps"). Two restrictions exist and they are
        // NOT interchangeable:
        //  - DISALLOW_INSTALL_UNKNOWN_SOURCES applies to the user it is set on and
        //    is the key the primary user's install flow has honoured since API 21.
        //  - DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY (API 29+, Device Owner
        //    only) applies to EVERY user on the device, including a secondary or
        //    guest user created later — which disallow_add_user may or may not be
        //    blocking, since that is a separate switch in the same policy.
        // We set both, so there is no gap on any of Android 10-16. The global
        // variant landed exactly at our API floor (29), so it needs no guard.
        //
        // Reported as two labels, not one: the calls are independent, so an OEM
        // that honours one and throws on the other would otherwise put the whole
        // rule in a single bucket and describe a device state that isn't real —
        // "unknownSources=blocked" filed as unapplied while the per-user
        // restriction is in fact set, or vice versa on the clear path.
        val unknownMode = ruleMode(policy, "block_unknown_sources")
        val blockUnknown = unknownMode == MODE_ENFORCE && policy.optBoolean("block_unknown_sources", false)
        val unknownState = "${if (blockUnknown) "blocked" else "allowed"}${modeNote(unknownMode)}"
        noteWatchGap("unknownSources", "block_unknown_sources", unknownMode)
        tryApply("unknownSources=$unknownState") {
            applyRestriction(android.os.UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES, blockUnknown)
        }
        tryApply("unknownSourcesGlobal=$unknownState") {
            applyRestriction(android.os.UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY, blockUnknown)
        }

        // Data-loss prevention: no phone-as-mass-storage. DISALLOW_USB_FILE_TRANSFER
        // removes the MTP/PTP file-transfer option from the USB preferences.
        // Charging over the same cable is unaffected — there is no API to stop
        // that, and no reason to want one.
        tryRestriction("usbTransfer", "disallow_usb_transfer", android.os.UserManager.DISALLOW_USB_FILE_TRANSFER)

        // DISALLOW_DEBUGGING_FEATURES closes Developer Options and USB debugging —
        // the route an employee would otherwise use to `adb` their way around
        // every other restriction here.
        tryRestriction("debugging", "disallow_debugging", android.os.UserManager.DISALLOW_DEBUGGING_FEATURES)

        // Screenshots and screen recording. setScreenCaptureDisabled is the only
        // API for this and it requires Device Owner / Profile Owner, so a plain
        // Device Admin is reported as unapplied instead of silently ignored. Note
        // the honest ceiling: it cannot stop somebody photographing the screen
        // with a second phone. No MDM can, and this one does not claim to.
        val captureMode = ruleMode(policy, "disable_screen_capture")
        val blockCapture = captureMode == MODE_ENFORCE && policy.optBoolean("disable_screen_capture", false)
        noteWatchGap("screenCapture", "disable_screen_capture", captureMode)
        tryApply("screenCapture=${if (blockCapture) "blocked" else "allowed"}${modeNote(captureMode)}") {
            if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
            dpm.setScreenCaptureDisabled(admin, blockCapture)
        }

        // Wi-Fi SSID allowlist — corporate networks only. This is the one rule in
        // the set whose enforceability depends on the OS version:
        //  - Android 13+ (API 33): setWifiSsidPolicy() takes a real allowlist and
        //    the platform refuses every SSID outside it.
        //  - Android 10-12: there is NO allowlist API. The nearest restriction,
        //    DISALLOW_CONFIG_WIFI, is all-or-nothing — it would stop the user
        //    configuring ANY network, including the corporate ones this rule is
        //    trying to permit, so it cannot express the policy. Applying a blunt
        //    substitute and calling it enforcement would be a lie, so the rule is
        //    reported as unenforceable on that handset and stays monitor-only:
        //    the breach detector still reads the connected SSID and reports it,
        //    which is exactly why monitor mode exists in POLICY_SCHEMA.
        val wifiMode = ruleMode(policy, "wifi_ssid_allowlist")
        val wifiAllowlist = stringList(policy, "wifi_ssid_allowlist")
        when {
            // Nothing to enforce — the rule is watched/off, or the allowlist is
            // empty, which means "any network". Either way, clear an allowlist a
            // previous 'enforce' policy latched into the platform, but only where
            // one could exist at all (API 33+ and Device Owner), so an ordinary
            // handset does not report a failure for a call that never needed
            // making. Note "no restriction" is spelled as a null policy, not an
            // empty allowlist (see applyWifiSsidAllowlist).
            wifiMode != MODE_ENFORCE || wifiAllowlist.isEmpty() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && isDeviceOwner()) {
                    tryApply("wifiAllowlist=unrestricted${modeNote(wifiMode)}") {
                        applyWifiSsidAllowlist(emptyList())
                    }
                }
            }
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ->
                unenforceable.append(
                    "wifiAllowlist[${wifiAllowlist.size} SSID(s); needs Android 13+, device runs " +
                        "${Build.VERSION.RELEASE} — monitor-only here] ",
                )
            // Deliberately NOT routed through tryApply(): its catch files every
            // exception under "requires Device Owner", and on an Android 13+
            // Device Owner — the only handset that reaches this branch — the
            // realistic failure is a bad value, not bad provisioning. Telling an
            // operator to re-enroll a correctly provisioned phone when the fix is
            // to correct one SSID in the console is exactly the conflation the
            // `unenforceable` bucket exists to prevent.
            else -> {
                val label = "wifiAllowlist[${wifiAllowlist.size}]"
                try {
                    applyWifiSsidAllowlist(wifiAllowlist)
                    applied.append("$label ")
                } catch (e: SecurityException) {
                    android.util.Log.w("SentroidPolicy", "'$label' requires Device Owner", e)
                    restricted.append("$label ")
                } catch (e: Exception) {
                    android.util.Log.w("SentroidPolicy", "'$label' rejected by the platform", e)
                    rejected.append("$label: ${e.message?.take(80)} ")
                }
            }
        }

        // --- Kiosk / lock task (OPT-IN) ---------------------------------------
        // Kept outside tryApply on purpose: applyKiosk() reports its outcome as a
        // sentence, the way setLocationEnabled() and reboot() do, and squeezing
        // that into a one-word "applied" label would throw away the honest part
        // (what got pinned, whether the power menu is really suppressed).
        val kioskNote = when {
            policy.optBoolean("kiosk_mode", false) -> applyKiosk(
                enabled = true,
                packages = stringList(policy, "kiosk_packages"),
                allowPowerMenu = policy.optBoolean("kiosk_allow_power_menu", false),
            )
            // kiosk_mode is off. Touch lock-task ONLY if this device is actually in
            // it, so an ordinary employee phone's policy never goes near these APIs
            // — while a device whose policy just turned kiosk off is genuinely
            // released instead of staying pinned to yesterday's app list forever.
            isKioskActive() -> applyKiosk(enabled = false, packages = emptyList(), allowPowerMenu = true)
            else -> null
        }

        val result = StringBuilder()
        if (applied.isNotEmpty()) result.append("applied: ${applied.toString().trim()}")
        if (restricted.isNotEmpty()) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append("requires Device Owner: ${restricted.toString().trim()}")
        }
        if (unenforceable.isNotEmpty()) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append("cannot be enforced on this Android version: ${unenforceable.toString().trim()}")
        }
        if (rejected.isNotEmpty()) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append("rejected by the device — fix the policy: ${rejected.toString().trim()}")
        }
        if (undetectable.isNotEmpty()) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append(
                "monitor requested but this agent has no detector — unblocked and unwatched: " +
                    undetectable.toString().trim(),
            )
        }
        if (kioskNote != null) {
            if (result.isNotEmpty()) result.append(" | ")
            result.append(kioskNote)
        }
        return result.toString().ifEmpty { "no policy changes" }
    }

    /**
     * Add or clear one user restriction, Device Owner–gated.
     *
     * The throw is the point: it hands applyPolicy()'s tryApply() a failure to
     * record instead of letting a plain Device Admin sail through a call the OS
     * was never going to honour. Same idiom as grantLocationPermissions() and
     * enforceOwnership().
     */
    private fun applyRestriction(restriction: String, on: Boolean) {
        if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
        if (on) dpm.addUserRestriction(admin, restriction) else dpm.clearUserRestriction(admin, restriction)
    }

    /** "(monitor)"/"(off)" so a policy result says WHY a rule is not blocking. */
    private fun modeNote(mode: String): String = if (mode == MODE_ENFORCE) "" else "($mode)"

    /**
     * Read a JSON string array out of a policy document, dropping blanks and
     * anything that is not a string. The server sends [] for "unset", and a
     * hand-edited policy can carry stray whitespace entries — both have to mean
     * "no entries" rather than an SSID or a package name made of spaces, which
     * would either be rejected by the platform or, worse, quietly accepted as a
     * rule nobody can satisfy.
     */
    private fun stringList(policy: JSONObject, key: String): List<String> {
        val arr = policy.optJSONArray(key) ?: return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            // opt(), not optString(): Android's optString runs a JSON null through
            // String.valueOf and hands back the literal "null" instead of the
            // fallback, which would become a phantom SSID (hard-enforced on
            // Android 13+) or a bogus package authorised for lock task.
            val value = (arr.opt(i) as? String)?.trim() ?: continue
            if (value.isNotEmpty()) out.add(value)
        }
        return out
    }

    /**
     * Hard-enforce the corporate Wi-Fi allowlist. Android 13 (API 33) and up only
     * — setWifiSsidPolicy is the sole API that can express "these SSIDs and no
     * others", and it simply does not exist below that, which is why the caller
     * reports the rule as unenforceable rather than substituting something
     * blunter. The version check lives here so no caller can reach the API 33
     * classes on an older handset.
     *
     * Two details worth spelling out:
     *  - The call takes no ComponentName. API 33 resolves the caller's Device
     *    Owner status from the calling package itself, so the admin component
     *    every other call in this class passes is not part of this signature.
     *  - An empty allowlist means "no restriction", which the platform spells as
     *    a null policy. Passing an empty set instead would be rejected — and read
     *    as "no network is permitted", the exact opposite of what the policy says.
     *
     * SSIDs travel over the air as raw bytes rather than text, so WifiSsid.fromBytes
     * takes the UTF-8 encoding of the name the operator typed into the console.
     */
    private fun applyWifiSsidAllowlist(ssids: List<String>) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            throw UnsupportedOperationException("requires Android 13+")
        }
        if (!dpm.isDeviceOwnerApp(context.packageName)) throw SecurityException("requires Device Owner")
        if (ssids.isEmpty()) {
            dpm.setWifiSsidPolicy(null)
            return
        }
        val allowed = ssids.map { ssid ->
            val bytes = ssid.toByteArray(Charsets.UTF_8)
            // Checked here so the failure names the offending entry: WifiSsid.fromBytes
            // throws a bare IllegalArgumentException for anything outside 1-32 bytes,
            // which tells an operator nothing about WHICH SSID to correct.
            require(bytes.size in 1..32) {
                "SSID \"$ssid\" is ${bytes.size} bytes; Wi-Fi names must be 1-32 bytes"
            }
            android.net.wifi.WifiSsid.fromBytes(bytes)
        }.toSet()
        // The shipped SDK exposes no createAllowlistPolicy() factory: the public
        // constructor with WIFI_SSID_POLICY_TYPE_ALLOWLIST is the allowlist form.
        dpm.setWifiSsidPolicy(
            android.app.admin.WifiSsidPolicy(
                android.app.admin.WifiSsidPolicy.WIFI_SSID_POLICY_TYPE_ALLOWLIST,
                allowed,
            ),
        )
    }

    /** Whether a lock-task allowlist is currently installed on this device. */
    private fun isKioskActive(): Boolean = runCatching {
        dpm.isDeviceOwnerApp(context.packageName) && dpm.getLockTaskPackages(admin).isNotEmpty()
    }.getOrDefault(false)

    /**
     * OPT-IN kiosk (lock task) mode: pin the device to an approved set of apps.
     *
     * Only reached when a policy explicitly sets kiosk_mode — lock task takes the
     * launcher away, so switching it on for an ordinary employee phone would
     * cripple the device rather than secure it. It suits a dedicated handset (POS,
     * scanner, signage), which is why POLICY_SCHEMA keeps it off by default.
     *
     * What each call actually does, so nobody reads more into the result string
     * than is there:
     *  - setLockTaskPackages AUTHORISES those packages for lock task. The device
     *    enters the pinned state when one of them calls startLockTask() (or is
     *    launched into it); the allowlist alone does not pin anything. The agent's
     *    own package is always included — leaving it out would authorise a kiosk
     *    the management agent itself is locked out of.
     *  - setLockTaskFeatures decides what the system UI still offers while pinned.
     *    It is API 28+; the app's floor is API 29, so it is always available here.
     *    HOME is mandatory for a usable multi-app kiosk and the platform also
     *    REQUIRES it alongside NOTIFICATIONS/OVERVIEW (it throws otherwise).
     *    KEYGUARD stays on: without it lock task suppresses the lock screen
     *    entirely, which would quietly void the password policy applied a few
     *    lines above in the same document.
     *  - Omitting LOCK_TASK_FEATURE_GLOBAL_ACTIONS is the only supported way to
     *    suppress the power/global-actions dialog. Be clear about the ceiling: a
     *    long-press (or power+volume) still forces a firmware-level shutdown that
     *    no Android API can intercept. This stops casual power-offs, not a
     *    determined one.
     *
     * Device Owner only; a plain Device Admin is told so rather than told nothing.
     */
    fun applyKiosk(enabled: Boolean, packages: List<String>, allowPowerMenu: Boolean): String {
        if (!dpm.isDeviceOwnerApp(context.packageName)) {
            return "kiosk unchanged: requires Device Owner (this device is Device Admin only)"
        }
        return try {
            if (!enabled) {
                // An empty allowlist genuinely releases the device: nothing is
                // permitted to enter lock task, and anything currently pinned is
                // let out by the platform.
                dpm.setLockTaskPackages(admin, emptyArray())
                // Put the platform default (the power/global-actions dialog) back,
                // or a device released from kiosk keeps a suppressed power menu
                // with no kiosk left to explain it.
                val restored = runCatching {
                    dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS)
                }.isSuccess
                return if (restored) {
                    "kiosk off — lock-task allowlist cleared, device released, power menu restored"
                } else {
                    "kiosk off — lock-task allowlist cleared, device released (lock-task features left unchanged)"
                }
            }
            val allowlist = (packages + context.packageName)
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .distinct()
            dpm.setLockTaskPackages(admin, allowlist.toTypedArray())
            var features = DevicePolicyManager.LOCK_TASK_FEATURE_HOME or
                DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS or
                DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO or
                DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD
            if (allowPowerMenu) {
                features = features or DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS
            }
            // The allowlist is already committed at this point, so a failure here
            // leaves a PARTIALLY applied kiosk — the packages authorised, the
            // lock-task features at whatever they were before (the platform
            // default includes GLOBAL_ACTIONS, i.e. the power menu this policy may
            // have asked to suppress). OEMs do reject feature combinations, so
            // that outcome gets its own sentence: letting it fall to the catch
            // below would report "kiosk unchanged" over a device that changed.
            val featureError = runCatching { dpm.setLockTaskFeatures(admin, features) }.exceptionOrNull()
            val head = "kiosk on — ${allowlist.size} app(s) allowed in lock task (agent included)"
            val tail = "; the device pins itself once an allowed app enters lock task"
            if (featureError == null) {
                head + ", power menu " +
                    (if (allowPowerMenu) "available" else "suppressed while pinned; a long-press power-off is firmware-level and cannot be blocked") +
                    tail
            } else {
                head + ", but lock-task features could not be set (${featureError.message?.take(60)}) — " +
                    "the power menu stays at its previous setting" + tail
            }
        } catch (e: Exception) {
            // Reserved for a setLockTaskPackages failure: nothing was authorised,
            // so the device really is unchanged.
            "kiosk unchanged: ${e.message?.take(60)}"
        }
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

    companion object {
        /** The device physically blocks the behaviour (default, block-first). */
        const val MODE_ENFORCE = "enforce"

        /** The device allows the behaviour but the breach detector reports it. */
        const val MODE_MONITOR = "monitor"

        /** Neither applied nor watched. */
        const val MODE_OFF = "off"

        /**
         * The rules ViolationMonitor actually has a detector for — the two signals
         * Android exposes to a non-system app (call state, connected SSID).
         *
         * 'monitor' is a two-part promise: the device stops blocking AND reports
         * every breach. applyPolicy keeps the first half for every rule, but only
         * these two get the second, so it names the rest in its own result bucket.
         * Taken from ViolationMonitor's own constants so adding a detector there
         * cannot leave this list quietly claiming less (or more) than is watched.
         */
        private val DETECTED_RULES = setOf(
            ViolationMonitor.RULE_OUTGOING_CALLS,
            ViolationMonitor.RULE_WIFI_ALLOWLIST,
        )

        /**
         * The enforcement mode for a single rule, mirroring ruleMode() in the
         * server's services/policyEngine.js so both ends of the wire read the
         * same policy the same way.
         *
         * Anything missing or unrecognised falls back to 'enforce': that is the
         * server's own default, it keeps a policy stored before rule_modes existed
         * behaving exactly as it did, and a typo in a hand-edited policy fails
         * closed (the rule keeps blocking) rather than silently opening the device
         * up. optString already returns the fallback for a non-string value, so a
         * mode written as a number or an object lands here too.
         */
        fun ruleMode(policy: JSONObject, rule: String): String {
            val modes = policy.optJSONObject("rule_modes") ?: return MODE_ENFORCE
            return when (val mode = modes.optString(rule, MODE_ENFORCE)) {
                MODE_ENFORCE, MODE_MONITOR, MODE_OFF -> mode
                else -> MODE_ENFORCE
            }
        }
    }
}
