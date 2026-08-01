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

    fun isRooted(): Boolean {
        // Root heuristics (su binaries) give false positives on emulator /
        // userdebug images, which bundle `su` for adb root. Skip them there; on a
        // real production device the checks below run normally.
        if (isEmulator()) return false
        val paths = listOf(
            "/system/app/Superuser.apk",
            "/sbin/su",
            "/system/bin/su",
            "/system/xbin/su",
            "/data/local/xbin/su",
            "/data/local/bin/su",
            "/system/sd/xbin/su",
            "/su/bin/su",
            "/system/bin/magisk",
        )
        return paths.any { File(it).exists() }
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
        }
        // Fallbacks: a recent cached fix, then last-known (may be stale).
        cachedLocation()?.let { return it }
        return lastLocation(context)?.also { cache(it) }
    }

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
