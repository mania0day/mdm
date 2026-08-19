package com.sentroid.agent.policy

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.sentroid.agent.data.Prefs
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The device half of 'monitor' mode: watch the rules the handset is told NOT to
 * block (or genuinely CANNOT block) and record every breach so it still leaves a
 * trace. (Proposal 5.3 Policy Enforcement — block-or-watch)
 *
 * A monitored rule is deliberately not enforced on the phone, so nothing in the
 * OS, the audit log or the compliance verdict would ever show it was broken.
 * These reports are the only evidence such a breach happened, which is what
 * makes "watch first, clamp down later" a real option instead of a checkbox —
 * and the only option at all for rules a given Android version cannot enforce
 * (an SSID allowlist needs Android 13+, every user restriction needs Device
 * Owner). A device that cannot block is still perfectly capable of reporting.
 *
 * Two signals are implemented, because they are the two the platform actually
 * exposes to a non-system app on Android 10-16:
 *
 *  - block_outgoing_calls -> call-state transitions. Intent.ACTION_NEW_OUTGOING_CALL
 *    is NOT usable: it is gated behind PROCESS_OUTGOING_CALLS, which Android 10
 *    (API 29) restricted to the default dialer / call-redirection app, so a
 *    manifest receiver would compile, install, and then never fire once. The
 *    supported signal is the call state itself — TelephonyCallback.CallStateListener
 *    on API 31+, the deprecated PhoneStateListener below it — with an
 *    IDLE -> OFFHOOK transition meaning "this device dialled out".
 *  - wifi_ssid_allowlist -> the SSID the device is actually joined to. From API 29
 *    this needs location permission (the agent grants itself fine + background
 *    location as Device Owner) and from API 31 the SSID inside NetworkCapabilities
 *    is redacted unless the network callback asked for location info.
 *
 * Everything here degrades honestly: when a signal is unavailable on this device
 * (no telephony hardware, permission not yet granted, SSID unreadable) the
 * monitor logs why and reports nothing, rather than inventing a breach or
 * pretending it is watching something it cannot see.
 *
 * A singleton because the detectors must outlive a single check-in cycle: calls
 * happen between check-ins, and the queue has to survive until the next one.
 */
object ViolationMonitor {

    private const val TAG = "SentroidMonitor"

    const val RULE_OUTGOING_CALLS = "block_outgoing_calls"
    const val RULE_WIFI_ALLOWLIST = "wifi_ssid_allowlist"

    /**
     * The server's zod schema accepts at most 50 violations per request and
     * rejects the whole batch above that, so the queue is capped to match. If a
     * device stays offline long enough to overflow it the OLDEST events are
     * dropped: the queue is evidence of an ongoing pattern, and an operator is
     * better served by what the device did most recently than by a frozen
     * snapshot from the start of the outage.
     */
    private const val MAX_QUEUED = 50

    /**
     * How long the same unapproved Wi-Fi network stays de-duplicated. See the
     * dedupe rule on reportedSsid below.
     */
    private const val WIFI_REREPORT_MS = 6 * 60 * 60 * 1000L

    /**
     * What WifiManager returns instead of the SSID when the caller lacks location
     * access or the OS location toggle is off. WifiManager.UNKNOWN_SSID only
     * exists from API 30, so the literal is matched directly to cover Android 10.
     */
    private const val UNKNOWN_SSID = "<unknown ssid>"

    // Breaches detected but not yet POSTed. Written from the telephony callback
    // (main thread) and drained from the check-in thread, so every access is
    // guarded by `lock`.
    private val pending = ArrayDeque<JSONObject>()
    private val lock = Any()

    // Application context captured in start(); never an Activity/Service, so
    // holding it in a singleton leaks nothing.
    @Volatile private var appContext: Context? = null

    // --- Outgoing-call detector state ----------------------------------------
    // The mode to report calls under ('monitor' or 'enforce'), or null while the
    // rule is off. Kept as a flag instead of re-reading the policy inside the
    // callback so that nothing about the user's calls is even looked at while
    // the rule is off — in that case the detector is unregistered outright.
    @Volatile private var callsWatchMode: String? = null
    @Volatile private var callsBlockable = false
    // TelephonyCallback only exists from API 31, so the reference is held as Any
    // and cast under the version gate; PhoneStateListener exists at every level
    // (deprecated from 31, hence the fully-qualified, suppressed declaration).
    @Volatile private var callsCallbackS: Any? = null
    @Suppress("DEPRECATION")
    @Volatile private var callsListenerLegacy: android.telephony.PhoneStateListener? = null
    // Set BEFORE the (main-thread) registration is posted, so a check-in that
    // lands while the post is still queued cannot register a second listener.
    @Volatile private var callWatchArmed = false
    private var lastCallState = TelephonyManager.CALL_STATE_IDLE
    private var callWatchPrimed = false

    // --- Wi-Fi detector state -------------------------------------------------
    @Volatile private var wifiCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var liveSsid: String? = null
    // Dedupe state for the Wi-Fi rule (see checkWifiAllowlist).
    @Volatile private var reportedSsid: String? = null
    @Volatile private var reportedSsidAt = 0L

    /** Reasons already logged, so a permanent limitation isn't logged every cycle. */
    private val loggedOnce = HashSet<String>()

    /**
     * Begin watching. Idempotent — the service calls this on every onStartCommand
     * (i.e. every alarm-driven check-in re-enters it), exactly like its network
     * and screen receivers.
     *
     * The watch flags are seeded from the LAST policy the server sent rather than
     * waiting for the next check-in: a call placed in the window between boot and
     * the first successful check-in is still a breach, and the detector has to be
     * listening before the call is dialled, not registered a minute later when
     * the policy finally arrives. An unenrolled device has no cached policy, so
     * it watches nothing at all.
     */
    fun start(context: Context) {
        val ctx = context.applicationContext
        appContext = ctx
        val cached = Prefs(ctx).lastPolicyJson ?: return
        val policy = runCatching { JSONObject(cached) }.getOrNull() ?: return
        syncCallWatch(ctx, policy)
        if (wifiRuleActive(policy)) ensureWifiWatch(ctx)
    }

    /**
     * Stop watching (service teardown). Anything already queued is deliberately
     * KEPT: the service is routinely destroyed and resurrected by its alarm, and
     * a breach that has been detected but not yet reported must survive that or
     * the evidence is lost for good.
     */
    fun stop(context: Context) {
        val ctx = context.applicationContext
        stopCallWatch(ctx)
        stopWifiWatch(ctx)
    }

    /**
     * One sweep, called from the check-in cycle: re-arm the detectors against the
     * current policy, sample the state-based rules, and hand back everything
     * queued since the last check-in for POSTing to /api/agent/violations.
     *
     * Returns an empty list when there is nothing to report — the caller should
     * not post at all in that case.
     */
    fun collectViolations(policy: JSONObject): List<JSONObject> {
        // start() is called from onStartCommand before any check-in can run, so
        // this only trips if the monitor is used out of order.
        val ctx = appContext ?: return emptyList()
        syncCallWatch(ctx, policy)
        checkWifiAllowlist(ctx, policy)
        return drain()
    }

    /**
     * Hand back violations whose POST failed (offline, server down) so the next
     * check-in retries them. Without this an outage would silently erase the only
     * record of a breach; a duplicate row is a far better failure than a gap.
     */
    fun requeue(violations: List<JSONObject>) {
        if (violations.isEmpty()) return
        synchronized(lock) {
            // Put them back in front — they are older than anything detected
            // since — and re-apply the cap from the oldest end, as enqueue does.
            for (v in violations.asReversed()) pending.addFirst(v)
            while (pending.size > MAX_QUEUED) pending.removeFirst()
        }
    }

    // ---- Rule plumbing --------------------------------------------------------

    // The mode of a rule is read through PolicyManager.ruleMode(), the same
    // helper the enforcement side uses, so the watcher and the blocker can never
    // disagree about what a policy says.

    /**
     * Values of a string-array policy field (e.g. wifi_ssid_allowlist), dropping
     * blanks — the server sends [] for "unset" and a hand-edited policy can carry
     * whitespace-only entries, neither of which names a network.
     */
    private fun stringList(policy: JSONObject, key: String): List<String> {
        val arr: JSONArray = policy.optJSONArray(key) ?: return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            arr.optString(i)?.trim()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        }
        return out
    }

    private fun wifiRuleActive(policy: JSONObject): Boolean =
        stringList(policy, RULE_WIFI_ALLOWLIST).isNotEmpty() &&
            PolicyManager.ruleMode(policy, RULE_WIFI_ALLOWLIST) != PolicyManager.MODE_OFF

    // ---- Outgoing calls -------------------------------------------------------

    /**
     * Arm or disarm the call detector for the current policy.
     *
     * Note it watches in 'enforce' mode too, not just 'monitor'. A rule that is
     * genuinely enforced simply never fires the detector — the OS refuses the
     * call, so there is no OFFHOOK to see — which means watching costs nothing
     * and catches the case that matters most: enforcement that silently failed,
     * or a device that was never actually Device Owner. The mode is carried on
     * every report so the operator can tell "we chose to watch this" apart from
     * "we tried to block this and it happened anyway".
     */
    private fun syncCallWatch(ctx: Context, policy: JSONObject) {
        val mode = PolicyManager.ruleMode(policy, RULE_OUTGOING_CALLS)
        // The rule can only be breached if the policy actually forbids calls;
        // a mode of 'monitor' on a rule set to false watches nothing.
        val active = policy.optBoolean(RULE_OUTGOING_CALLS, false) && mode != PolicyManager.MODE_OFF
        if (!active) {
            callsWatchMode = null
            stopCallWatch(ctx)
            return
        }
        callsWatchMode = mode
        // DISALLOW_OUTGOING_CALLS is a Device Owner–only user restriction, so a
        // plain Device Admin can watch but can never block.
        callsBlockable = runCatching { PolicyManager(ctx).isDeviceOwner() }.getOrDefault(false)
        startCallWatch(ctx)
    }

    /**
     * Register the call-state listener. Idempotent, and deliberately RETRIED on
     * every check-in while unregistered: on a fresh device READ_PHONE_STATE is
     * granted by the agent itself (as Device Owner) during the first applyPolicy,
     * so an attempt made at boot fails and the one after the first check-in
     * succeeds. A permanent limitation is logged once and left alone.
     */
    private fun startCallWatch(ctx: Context) {
        if (callWatchArmed) return
        if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) {
            logOnce("calls-no-telephony", "no telephony hardware — this device cannot place calls, so there is nothing to watch")
            return
        }
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            logOnce(
                "calls-no-permission",
                "outgoing-call monitoring inactive: READ_PHONE_STATE not granted yet " +
                    "(Device Owner grants it during policy apply; retried each check-in)",
            )
            return
        }
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
        callWatchArmed = true
        // PhoneStateListener takes the Looper of the thread that constructs it, and
        // check-ins run on a background thread with no Looper at all, so both
        // registration paths are pinned to the main thread.
        runOnMain {
            callWatchPrimed = false
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Android 12+ : PhoneStateListener is deprecated and its
                    // call-state event is only delivered to TelephonyCallback.
                    val cb = CallStateWatcher()
                    tm.registerTelephonyCallback(ctx.mainExecutor, cb)
                    callsCallbackS = cb
                } else {
                    // Android 10-11: TelephonyCallback does not exist yet.
                    @Suppress("DEPRECATION")
                    val l = object : android.telephony.PhoneStateListener() {
                        @Deprecated("PhoneStateListener is replaced by TelephonyCallback on API 31+")
                        override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                            // phoneNumber is always empty from API 29 unless the app
                            // holds READ_CALL_LOG, which SENTROID deliberately does
                            // not request — the fact that a call was placed is the
                            // policy breach; who was dialled is not the agent's
                            // business and would be a needless privacy escalation.
                            onCallState(state)
                        }
                    }
                    @Suppress("DEPRECATION")
                    tm.listen(l, android.telephony.PhoneStateListener.LISTEN_CALL_STATE)
                    callsListenerLegacy = l
                }
            } catch (e: SecurityException) {
                // API 31+ enforces READ_PHONE_STATE at registration time; report
                // the real reason rather than appearing to watch and never firing.
                callWatchArmed = false
                logOnce("calls-register-denied", "outgoing-call monitoring refused by the OS: ${e.message}")
            } catch (e: Exception) {
                callWatchArmed = false
                logOnce("calls-register-failed", "outgoing-call monitoring could not start: ${e.message}")
            }
        }
    }

    private fun stopCallWatch(ctx: Context) {
        if (!callWatchArmed) return
        callWatchArmed = false
        val cbS = callsCallbackS
        val legacy = callsListenerLegacy
        callsCallbackS = null
        callsListenerLegacy = null
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
        runOnMain {
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && cbS is TelephonyCallback) {
                    tm.unregisterTelephonyCallback(cbS)
                } else if (legacy != null) {
                    @Suppress("DEPRECATION")
                    tm.listen(legacy, android.telephony.PhoneStateListener.LISTEN_NONE)
                }
            }
        }
    }

    /**
     * API 31+ call-state watcher. Kept as its own class so the TelephonyCallback
     * type is only ever resolved on a device that actually has it — a class whose
     * superclass is missing fails to load outright, unlike a gated method body.
     */
    private class CallStateWatcher : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) = ViolationMonitor.onCallState(state)
    }

    /**
     * The outgoing-call test, shared by both registration paths.
     *
     * IDLE -> OFFHOOK is a call this device DIALLED. An incoming call the user
     * answers always passes through RINGING first (RINGING -> OFFHOOK), so the
     * previous state is what separates "made a call" from "took a call" — and
     * that transition is the only outgoing-call signal Android leaves open to a
     * non-dialer app on API 29+ (see the class comment on ACTION_NEW_OUTGOING_CALL).
     *
     * No de-duplication is applied here: every dialled call is its own discrete
     * breach and deserves its own row. The queue cap is the only limit.
     *
     * Known limitation, stated rather than papered over: an EMERGENCY call is
     * indistinguishable from any other outgoing call at this layer. The dialled
     * number is withheld from any app without READ_CALL_LOG (which the agent does
     * not request), so a 999/911 call — which DISALLOW_OUTGOING_CALLS also
     * deliberately still permits — is reported like the rest, and the operator
     * has to read it in context. The alternative, holding the call-log
     * permission to filter them out, is a far bigger privacy cost than an
     * occasional row an admin can dismiss.
     */
    @Synchronized
    private fun onCallState(state: Int) {
        // Both registration APIs deliver the CURRENT state immediately on
        // registration. That first delivery is swallowed: if the agent starts
        // while a call is already up — the service is restarted mid-call, or the
        // phone rebooted into one — an unprimed state machine would read the
        // standing OFFHOOK as a brand-new outgoing call and report a breach that
        // never happened.
        if (!callWatchPrimed) {
            callWatchPrimed = true
            lastCallState = state
            return
        }
        val prev = lastCallState
        lastCallState = state
        if (state != TelephonyManager.CALL_STATE_OFFHOOK) return
        if (prev == TelephonyManager.CALL_STATE_OFFHOOK) return // duplicate/ dual-SIM re-report
        if (prev == TelephonyManager.CALL_STATE_RINGING) return // incoming call, answered
        val mode = callsWatchMode ?: return

        val blockable = callsBlockable
        val detail = when {
            mode == PolicyManager.MODE_MONITOR ->
                "Outgoing call placed. Policy monitors outgoing calls on this device, " +
                    "so the call was recorded but not blocked."
            blockable ->
                "Outgoing call placed even though policy enforces a block on outgoing calls — " +
                    "the DISALLOW_OUTGOING_CALLS restriction did not stop it."
            else ->
                "Outgoing call placed. Policy blocks outgoing calls, but this device is not " +
                    "Device Owner, so DISALLOW_OUTGOING_CALLS cannot be applied — the call could " +
                    "only be observed, not prevented."
        }
        enqueue(
            violation(
                rule = RULE_OUTGOING_CALLS,
                mode = mode,
                detail = detail,
                metadata = JSONObject()
                    .put("detected_via", "call_state_idle_to_offhook")
                    .put("sdk_int", Build.VERSION.SDK_INT)
                    .put("enforceable", blockable)
                    // Stated explicitly so nobody reads the absence of a number as
                    // a failed lookup: Android 10+ withholds it from any app
                    // without READ_CALL_LOG, which the agent does not request.
                    .put("dialled_number", "unavailable (requires READ_CALL_LOG; not requested)"),
            ),
        )
    }

    // ---- Wi-Fi SSID allowlist -------------------------------------------------

    /**
     * Compare the network the device is joined to against the corporate
     * allowlist. This is the rule monitor mode exists for: hard enforcement
     * (setWifiSsidPolicy) needs Android 13+ AND Device Owner, so on Android
     * 10-12 — most of the supported range — observing and reporting is the only
     * thing the platform allows at all.
     */
    private fun checkWifiAllowlist(ctx: Context, policy: JSONObject) {
        val allowlist = stringList(policy, RULE_WIFI_ALLOWLIST)
        val mode = PolicyManager.ruleMode(policy, RULE_WIFI_ALLOWLIST)
        if (allowlist.isEmpty() || mode == PolicyManager.MODE_OFF) {
            // An empty allowlist means "any network is fine", so there is nothing
            // to breach. Forget any earlier report — if the rule is re-armed
            // later, the network the device is on then is a fresh breach.
            reportedSsid = null
            stopWifiWatch(ctx)
            return
        }
        ensureWifiWatch(ctx)

        if (!isWifiConnected(ctx)) {
            // Definitively not on Wi-Fi (cellular/ethernet/offline): clear the
            // dedupe state so rejoining the same bad network reports again.
            reportedSsid = null
            return
        }
        // On Wi-Fi but the SSID could not be read: keep the dedupe state as-is
        // and report NOTHING. An unreadable SSID is not evidence of a breach and
        // must never be turned into one (currentSsid logs the real reason).
        val ssid = currentSsid(ctx) ?: return

        // SSIDs are case-sensitive byte strings, so the comparison is exact.
        if (allowlist.contains(ssid)) {
            reportedSsid = null
            return
        }

        // Dedupe: an unapproved network is a CONTINUING condition — the device
        // stays joined for hours — while check-ins run every 15-30s. Reporting on
        // every cycle would bury one breach under hundreds of identical rows. So
        // a given SSID is reported once when first seen, and again only if
        //   (a) the device leaves it (or joins an approved one) and comes back —
        //       a genuinely new join, handled by clearing reportedSsid above, or
        //   (b) it is STILL connected WIFI_REREPORT_MS later, so a week-long
        //       breach leaves periodic evidence instead of one lonely row.
        // This state is in memory only: if the process is killed the first
        // check-in after restart re-reports the current network, which is the
        // safe direction to err — a duplicate row rather than a silent gap.
        val now = System.currentTimeMillis()
        if (ssid == reportedSsid && now - reportedSsidAt < WIFI_REREPORT_MS) return
        reportedSsid = ssid
        reportedSsidAt = now

        val owner = runCatching { PolicyManager(ctx).isDeviceOwner() }.getOrDefault(false)
        val blockable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && owner
        val detail = StringBuilder(
            "Connected to Wi-Fi \"$ssid\", which is not on the approved list " +
                "(${allowlist.joinToString(", ")}).",
        )
        when {
            mode == PolicyManager.MODE_MONITOR ->
                detail.append(" This rule is in monitor mode, so the connection was recorded but not blocked.")
            blockable ->
                detail.append(" The SSID allowlist is enforced on this device, so this connection should not have been possible.")
            else ->
                detail.append(
                    " Enforcement is impossible on this device: an SSID allowlist requires Android 13+ " +
                        "(this device runs Android ${Build.VERSION.RELEASE}) and Device Owner " +
                        "(${if (owner) "granted" else "not granted"}), so the network could only be observed.",
                )
        }
        enqueue(
            violation(
                rule = RULE_WIFI_ALLOWLIST,
                mode = mode,
                detail = detail.toString(),
                metadata = JSONObject()
                    .put("ssid", ssid)
                    .put("allowlist", JSONArray(allowlist))
                    .put("sdk_int", Build.VERSION.SDK_INT)
                    .put("enforceable", blockable)
                    .put("device_owner", owner),
            ),
        )
    }

    /**
     * Whether this device is joined to a Wi-Fi network at all.
     *
     * Deliberately NOT just "is the default route Wi-Fi": a captive-portal
     * network (hotel, airport, coffee shop) never validates until the user signs
     * in, and Android keeps the default route on cellular in the meantime. That
     * is precisely the network an allowlist exists to catch, so a cellular
     * default route must not be read as "not on Wi-Fi" — the device is still
     * associated, and anything that talks to the local subnet still goes there.
     */
    private fun isWifiConnected(ctx: Context): Boolean {
        // On API 31+ the live callback is authoritative and already knows.
        if (liveSsid != null) return true
        return runCatching {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val wifiCaps = { n: Network? ->
                n != null && cm.getNetworkCapabilities(n)
                    ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            }
            // getAllNetworks() is deprecated from API 31, where the callback above
            // covers us; below that it is the only way to see a joined-but-not-
            // default Wi-Fi network.
            @Suppress("DEPRECATION")
            wifiCaps(cm.activeNetwork) || cm.allNetworks.any { wifiCaps(it) }
        }.getOrDefault(false)
    }

    /**
     * The SSID of the connected network, or null when it genuinely cannot be
     * read (logged, never guessed).
     *
     * Two paths, because Android changed the rules mid-range:
     *  - API 31+ : the WifiInfo inside NetworkCapabilities is REDACTED to
     *    "<unknown ssid>" unless the network callback was registered with
     *    FLAG_INCLUDE_LOCATION_INFO, and a synchronous getNetworkCapabilities()
     *    can never carry that flag. So the live callback feed is the only
     *    reliable read — and it doubles as a zero-latency cache.
     *  - API 29-30: no such flag exists; WifiManager.getConnectionInfo() is the
     *    supported read (deprecated only from API 31). It needs ACCESS_WIFI_STATE,
     *    ACCESS_FINE_LOCATION, ACCESS_BACKGROUND_LOCATION (the agent reads it
     *    from a service) and the OS location toggle ON — miss any of those and
     *    Android quietly hands back "<unknown ssid>" instead of failing, which is
     *    exactly why that literal is treated as "unknown" rather than as a name.
     * getConnectionInfo() also stays as the fallback on API 31+ for the moment
     * before the first callback lands.
     */
    private fun currentSsid(ctx: Context): String? {
        liveSsid?.let { return it }
        return try {
            val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                ?: return null
            @Suppress("DEPRECATION")
            val ssid = normalizeSsid(wm.connectionInfo?.ssid)
            if (ssid == null) {
                logOnce(
                    "wifi-unknown-ssid",
                    "connected to Wi-Fi but the SSID is unreadable — needs ACCESS_WIFI_STATE, " +
                        "fine + background location and the OS location toggle ON; reporting nothing",
                )
            }
            ssid
        } catch (e: SecurityException) {
            // Most likely ACCESS_WIFI_STATE missing from the manifest.
            logOnce("wifi-denied", "cannot read the connected SSID: ${e.message}")
            null
        } catch (e: Exception) {
            logOnce("wifi-failed", "cannot read the connected SSID: ${e.message}")
            null
        }
    }

    /** Strip WifiManager's surrounding quotes and reject the "unknown" sentinels. */
    private fun normalizeSsid(raw: String?): String? {
        val s = raw?.trim()?.removeSurrounding("\"")?.trim() ?: return null
        // "0x..." is the hex form Android uses for an SSID that isn't valid UTF-8.
        if (s.isBlank() || s == UNKNOWN_SSID || s == "0x") return null
        return s
    }

    /**
     * Keep a live, un-redacted SSID on API 31+ (see currentSsid). Registered only
     * while the rule is armed, so the agent isn't holding a Wi-Fi location feed
     * open for a policy that doesn't use one.
     */
    private fun ensureWifiWatch(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        if (wifiCallback != null) return
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        try {
            val cb = object : ConnectivityManager.NetworkCallback(
                ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO,
            ) {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return
                    liveSsid = normalizeSsid((caps.transportInfo as? WifiInfo)?.ssid)
                }

                override fun onLost(network: Network) {
                    liveSsid = null
                }
            }
            // No INTERNET capability is requested on purpose: a captive-portal
            // network that never validates is precisely the kind of "free wifi"
            // the allowlist is meant to catch, and requiring INTERNET would make
            // the monitor blind to it.
            val req = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build()
            cm.registerNetworkCallback(req, cb)
            wifiCallback = cb
        } catch (e: Exception) {
            logOnce("wifi-callback-failed", "live SSID feed unavailable, falling back to WifiManager: ${e.message}")
        }
    }

    private fun stopWifiWatch(ctx: Context) {
        val cb = wifiCallback ?: return
        wifiCallback = null
        liveSsid = null
        runCatching {
            (ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
                ?.unregisterNetworkCallback(cb)
        }
    }

    // ---- Queue / helpers ------------------------------------------------------

    private fun enqueue(v: JSONObject) {
        synchronized(lock) {
            pending.addLast(v)
            while (pending.size > MAX_QUEUED) pending.removeFirst()
        }
    }

    private fun drain(): List<JSONObject> = synchronized(lock) {
        if (pending.isEmpty()) return emptyList()
        val out = ArrayList<JSONObject>(pending)
        pending.clear()
        out
    }

    /** One violation in the shape /api/agent/violations expects. */
    private fun violation(rule: String, mode: String, detail: String, metadata: JSONObject): JSONObject =
        JSONObject()
            .put("rule", rule)
            .put("mode", mode)
            // The server caps detail at 500 chars and rejects the WHOLE batch when
            // one entry is over, so it is trimmed here rather than costing every
            // other violation in the request.
            .put("detail", detail.take(500))
            .put("metadata", metadata)
            // Device clock at detection, not at report time: a phone that was
            // offline for an hour must say when the breach happened, not when it
            // finally managed to phone home (the server keeps its own created_at
            // for that). ISO-8601 UTC, which the console parses directly.
            .put("occurred_at", nowIso())

    private val isoUtc: SimpleDateFormat by lazy {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
    }

    // SimpleDateFormat is not thread-safe and this is called from both the
    // telephony callback and the check-in thread.
    private fun nowIso(): String = synchronized(isoUtc) { isoUtc.format(Date()) }

    /**
     * PhoneStateListener must be built on a thread with a Looper, and telephony
     * (un)registration is cheap, so both are pinned to the main thread — check-ins
     * run on a bare background thread.
     */
    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block()
        else Handler(Looper.getMainLooper()).post(block)
    }

    /**
     * Log a limitation once instead of on every check-in. These are mostly
     * permanent facts about the device (no telephony, no Device Owner), and a
     * 15-second poll would otherwise turn each into a logcat flood.
     */
    private fun logOnce(key: String, message: String) {
        synchronized(loggedOnce) { if (!loggedOnce.add(key)) return }
        android.util.Log.w(TAG, message)
    }
}
