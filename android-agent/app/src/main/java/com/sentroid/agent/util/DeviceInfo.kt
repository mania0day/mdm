package com.sentroid.agent.util

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.location.LocationManager
import androidx.core.content.ContextCompat
import com.sentroid.agent.BuildConfig
import java.io.File

/** Collects live device telemetry reported to the MDM server on each check-in. */
object DeviceInfo {

    // Cache the most recent obtained fix. Android/emulator does not always retain
    // a last-known location, so we remember the last good fix and serve it (if
    // recent) when an instantaneous fresh request doesn't return in time.
    @Volatile private var cachedFix: Pair<Double, Double>? = null
    @Volatile private var cachedAt: Long = 0L
    private const val CACHE_MAX_AGE_MS = 10 * 60 * 1000L

    // Honor the build-time identity override (used to represent a specific target
    // handset on an emulator during testing); falls back to real hardware values.
    fun manufacturer(): String =
        BuildConfig.DEVICE_MANUFACTURER_OVERRIDE.ifBlank { Build.MANUFACTURER ?: "unknown" }

    fun model(): String =
        BuildConfig.DEVICE_MODEL_OVERRIDE.ifBlank { Build.MODEL ?: "unknown" }
    fun osVersion(): String = Build.VERSION.RELEASE ?: "?"
    fun sdkInt(): Int = Build.VERSION.SDK_INT
    fun serial(): String = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Build.getSerial() else Build.SERIAL
    } catch (e: SecurityException) {
        Build.UNKNOWN
    }

    /** Full build fingerprint — useful for spotting tampered/custom builds. No permission needed. */
    fun buildFingerprint(): String = Build.FINGERPRINT ?: "unknown"

    /** Monthly Android security patch level, e.g. "2026-06-01". No permission needed. */
    fun securityPatch(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Build.VERSION.SECURITY_PATCH ?: "unknown" else "unknown"

    /** "device_owner" (full fleet control) | "device_admin" (basic control) | "none". */
    fun managementMode(context: Context): String {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
        return when {
            dpm.isDeviceOwnerApp(context.packageName) -> "device_owner"
            dpm.isAdminActive(
                android.content.ComponentName(context, com.sentroid.agent.admin.SentroidDeviceAdminReceiver::class.java),
            ) -> "device_admin"
            else -> "none"
        }
    }

    /**
     * IMEI is only readable by an app that IS the Device Owner (or holds carrier
     * privileges) — Android blocks it for every other app since API 29,
     * regardless of granted permissions. Returns null everywhere else rather
     * than throwing, so this never breaks check-in on a regular (non-owner)
     * enrolled device — the normal case for a BYOD/non-rooted fleet phone.
     */
    @Suppress("DEPRECATION")
    fun imei(context: Context): String? {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(context.packageName)) return null
        return try {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tm.imei else tm.deviceId
        } catch (e: SecurityException) {
            null
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Best-effort SIM-registered phone number. Frequently null/blank — many
     * carriers never populate it regardless of permission state — so this is
     * reported when available and otherwise left for an admin to enter
     * manually in the console. Never blocks or crashes check-in.
     */
    fun phoneNumber(context: Context): String? {
        val granted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.READ_PHONE_STATE,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) return null
        return try {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
            @Suppress("DEPRECATION")
            tm.line1Number?.trim()?.takeIf { it.isNotBlank() }
        } catch (e: SecurityException) {
            null
        } catch (e: Exception) {
            null
        }
    }

    /** Best-effort carrier/SIM operator name. Not permission-gated on most OEMs. */
    fun simOperator(context: Context): String? = try {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
        tm.networkOperatorName?.trim()?.takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    }

    fun batteryLevel(context: Context): Int {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    fun batteryCharging(context: Context): Boolean {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.isCharging
    }

    fun networkType(context: Context): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
                as android.net.ConnectivityManager
        val nc = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    /**
     * Best-effort root detection via the presence of common `su` binaries /
     * superuser packages. (We deliberately do not flag `test-keys` builds — every
     * emulator/AOSP image carries that tag and it is not a reliable indicator of a
     * compromised production device.)
     */
    private fun isEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.lowercase().contains("emulator") ||
            Build.HARDWARE in listOf("goldfish", "ranchu", "cutf_cvm") ||
            (Build.PRODUCT ?: "").contains("sdk") ||
            (Build.PRODUCT ?: "").contains("emulator")

    /**
     * Whether the keyguard is currently engaged (screen locked). Reported on
     * every check-in so the console reflects the device's real lock state
     * rather than only the last state it commanded.
     */
    fun isDeviceLocked(context: Context): Boolean {
        val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? android.app.KeyguardManager
            ?: return false
        return runCatching { km.isKeyguardLocked }.getOrDefault(false)
    }

    /** Whether any screen-lock credential (PIN/pattern/password) is configured. */
    fun isPasswordSet(context: Context): Boolean {
        val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? android.app.KeyguardManager
            ?: return false
        return runCatching { km.isDeviceSecure }.getOrDefault(false)
    }

    /** Root-management apps. Their presence is the single strongest signal. */
    private val rootPackages = listOf(
        "com.topjohnwu.magisk",
        "eu.chainfire.supersu",
        "com.noshufou.android.su",
        "com.noshufou.android.su.elite",
        "com.koushikdutta.superuser",
        "com.thirdparty.superuser",
        "com.yellowes.su",
        "me.weishu.kernelsu",
        "com.kingroot.kinguser",
        "com.kingo.root",
    )

    /**
     * Paths that indicate an actual root install. `/sbin/su` is deliberately
     * NOT in this list: stock MIUI ships it on retail `user/release-keys`
     * builds, so treating it as proof of root marks every stock Redmi as
     * compromised — which permanently pins the device to non-compliant.
     * These locations only contain `su` when root has really been installed.
     */
    private val rootBinaries = listOf(
        "/system/app/Superuser.apk",
        "/system/bin/su",
        "/system/xbin/su",
        "/system/sbin/su",
        "/data/local/xbin/su",
        "/data/local/bin/su",
        "/system/sd/xbin/su",
        "/su/bin/su",
        "/system/bin/magisk",
        "/system/bin/.ext/.su",
        "/cache/magisk.log",
    )

    /**
     * Best-effort root detection. Requires a *positive* signal — an installed
     * root manager, a su binary in a location only root installs write to, or
     * a non-release build signature — rather than the mere existence of any
     * file named `su` anywhere on the filesystem.
     */
    fun isRooted(context: Context? = null): Boolean {
        // Emulator/userdebug images bundle `su` for `adb root`; that is expected,
        // not a compromise.
        if (isEmulator()) return false

        // 1. A root manager app is installed.
        if (context != null) {
            val pm = context.packageManager
            for (p in rootPackages) {
                val found = runCatching {
                    @Suppress("DEPRECATION")
                    pm.getPackageInfo(p, 0)
                    true
                }.getOrDefault(false)
                if (found) return true
            }
        }

        // 2. A su binary sits somewhere only a root install would put it, and
        //    is actually executable (a bare unreadable stub doesn't count).
        if (rootBinaries.any { val f = File(it); f.exists() && f.canExecute() }) return true

        // 3. The build itself isn't a signed release image. On a retail device
        //    this means the ROM was replaced.
        if ((Build.TAGS ?: "").contains("test-keys")) return true

        return false
    }

    /** Whether device storage is reported as encrypted. */
    fun encryptionOn(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE)
                as android.app.admin.DevicePolicyManager
        return dpm.storageEncryptionStatus ==
            android.app.admin.DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE ||
            dpm.storageEncryptionStatus ==
            android.app.admin.DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_PER_USER
    }

    /**
     * Actively request a fresh single location fix (falling back to last-known).
     * Android does not retain a last-known location unless something requests
     * updates, so LOCATE / telemetry must ask for a current fix. Blocks up to
     * timeoutMs; safe to call from a background thread.
     */
    fun requestFreshLocation(context: Context, timeoutMs: Long = 6000): Pair<Double, Double>? {
        val fine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return null

        // Prefer an actively-obtained CURRENT fix — essential for locating a moving
        // or lost device on demand. Only if that fails do we fall back to a recent
        // cache and then to last-known (which can be stale).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                val latch = java.util.concurrent.CountDownLatch(1)
                val holder = arrayOfNulls<android.location.Location>(1)
                val signals = mutableListOf<android.os.CancellationSignal>()
                val providers = mutableListOf<String>()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) providers.add(LocationManager.FUSED_PROVIDER)
                providers.add(LocationManager.GPS_PROVIDER)
                providers.add(LocationManager.NETWORK_PROVIDER)
                for (p in providers) {
                    if (lm.isProviderEnabled(p)) {
                        val sig = android.os.CancellationSignal()
                        signals.add(sig)
                        // Use a shared, long-lived daemon executor (never shut down) so
                        // a late callback is never rejected; cancel the request after the
                        // wait so no result is delivered post-timeout.
                        lm.getCurrentLocation(p, sig, locExecutor, java.util.function.Consumer { loc ->
                            if (loc != null && holder[0] == null) {
                                holder[0] = loc
                                latch.countDown()
                            }
                        })
                    }
                }
                latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                signals.forEach { runCatching { it.cancel() } }
                holder[0]?.let {
                    val fresh = Pair(it.latitude, it.longitude)
                    cache(fresh)
                    return fresh
                }
            } catch (e: SecurityException) {
                // fall through to cache / last-known
            } catch (e: Exception) {
                // fall through to cache / last-known
            }
        } else {
            // Pre-Android 11 there is no getCurrentLocation(), so without this
            // branch a LOCATE on an older device would silently degrade to
            // whatever stale fix happened to be cached — never actually turning
            // the radio on when the server asks. Request live updates instead
            // and tear them down as soon as we have a fix or time out.
            try {
                val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                val latch = java.util.concurrent.CountDownLatch(1)
                val holder = arrayOfNulls<android.location.Location>(1)
                val listener = object : android.location.LocationListener {
                    override fun onLocationChanged(location: android.location.Location) {
                        if (holder[0] == null) {
                            holder[0] = location
                            latch.countDown()
                        }
                    }

                    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
                    override fun onProviderEnabled(provider: String) {}
                    override fun onProviderDisabled(provider: String) {}
                }
                val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
                    .filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
                if (providers.isNotEmpty()) {
                    // Callbacks are delivered to the main looper, so this
                    // background thread is free to block on the latch.
                    for (p in providers) {
                        lm.requestLocationUpdates(p, 0L, 0f, listener, android.os.Looper.getMainLooper())
                    }
                    latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                    runCatching { lm.removeUpdates(listener) }
                    holder[0]?.let {
                        val fresh = Pair(it.latitude, it.longitude)
                        cache(fresh)
                        return fresh
                    }
                }
            } catch (e: SecurityException) {
                // fall through to cache / last-known
            } catch (e: Exception) {
                // fall through to cache / last-known
            }
        }
        // Fallbacks: a recent cached fix, then last-known (may be stale).
        cachedLocation()?.let { return it }
        return lastLocation(context)?.also { cache(it) }
    }

    /** Whether either location permission is currently granted. */
    fun hasLocationPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Whether the OS location toggle is on at all (independent of app permission). */
    fun locationServicesEnabled(context: Context): Boolean = runCatching {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }.getOrDefault(false)

    // Shared daemon executor for async location callbacks; never shut down, so a
    // late getCurrentLocation delivery can never hit a terminated executor.
    private val locExecutor: java.util.concurrent.Executor by lazy {
        java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "sentroid-loc").apply { isDaemon = true }
        }
    }

    /** Return a recently-cached fix without performing a (costly) fresh request. */
    fun cachedLocation(): Pair<Double, Double>? {
        val c = cachedFix
        return if (c != null && System.currentTimeMillis() - cachedAt < CACHE_MAX_AGE_MS) c else null
    }

    private fun cache(fix: Pair<Double, Double>) {
        cachedFix = fix
        cachedAt = System.currentTimeMillis()
    }

    /** Last-known coarse/fine location, if permitted. */
    fun lastLocation(context: Context): Pair<Double, Double>? {
        val fine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return null
        return try {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val providers = lm.getProviders(true)
            var best: android.location.Location? = null
            for (p in providers) {
                val l = lm.getLastKnownLocation(p) ?: continue
                if (best == null || l.accuracy < best!!.accuracy) best = l
            }
            best?.let { Pair(it.latitude, it.longitude) }
        } catch (e: SecurityException) {
            null
        }
    }
}
