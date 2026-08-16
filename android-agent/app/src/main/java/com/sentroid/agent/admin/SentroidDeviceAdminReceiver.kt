package com.sentroid.agent.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import android.widget.Toast
import com.sentroid.agent.data.ApiClient
import com.sentroid.agent.data.Prefs
import com.sentroid.agent.service.SentroidService

/**
 * Receives Device Administration lifecycle callbacks. Being an active device
 * admin is what allows SENTROID to remotely lock, wipe, and enforce password
 * policy on the device (Proposal 5.2 / 6.2 Remote Device Control).
 */
class SentroidDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Toast.makeText(context, "SENTROID device administration enabled", Toast.LENGTH_SHORT).show()
    }

    /**
     * Called by the system after QR / NFC / zero-touch provisioning completes and
     * this app has been made Device Owner. We read the server URL and enrollment
     * token that the admin embedded in the provisioning QR, stash them, and start
     * the agent, which auto-enrolls as soon as the network is up — no manual entry.
     */
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        val extras: PersistableBundle? =
            intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        val prefs = Prefs(context)
        extras?.getString(EXTRA_SERVER_URL)?.takeIf { it.isNotBlank() }?.let { prefs.serverUrl = it }
        extras?.getString(EXTRA_ENROLL_TOKEN)?.takeIf { it.isNotBlank() }?.let { prefs.pendingEnrollToken = it }
        // Kick the agent; it will consume the pending token and enroll automatically.
        SentroidService.start(context)
        // Bring up the status screen so the operator can see it succeed.
        context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ?.let { runCatching { context.startActivity(it) } }
    }

    /**
     * Fired the moment the user taps "Deactivate this device admin app" in
     * Settings, BEFORE the confirmation dialog even shows — the app is still
     * fully running normally here (no teardown risk), which makes this the
     * most reliable point to warn the server, well before onDisabled()'s
     * narrower window. Reported eagerly so the server knows even if the user
     * changes their mind afterward and never actually confirms.
     */
    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        reportTamper(context, "ADMIN_DISABLE_REQUESTED", "requested deactivation of device administration")
        return "Disabling SENTROID administration removes this device from secure management " +
            "and may violate organizational security policy."
    }

    /**
     * Fired by the OS the moment device administration is actually turned off —
     * which is also the mandatory first step before this app can be uninstalled
     * (a plain Device Admin can't be removed while still active). The device's
     * token and process are both still alive for a brief window here, so this
     * is the last reliable chance to warn the server that the device is about
     * to go dark, before an uninstall silently removes it with no trace. Fired
     * in addition to (not instead of) onDisableRequested() above — this one
     * confirms deactivation actually completed, that one fires earlier and more
     * reliably but only means the user opened the confirmation dialog.
     */
    override fun onDisabled(context: Context, intent: Intent) {
        reportTamper(context, "ADMIN_DISABLED", "device administration was turned off")
    }

    /**
     * goAsync() + a background thread because network calls can't run on the
     * receiver's main-thread callback, and the receiver would otherwise be
     * torn down before a blocking call finishes.
     */
    private fun reportTamper(context: Context, type: String, action: String) {
        val prefs = Prefs(context)
        val server = prefs.serverUrl
        val token = prefs.deviceToken
        if (server.isBlank() || token.isNullOrBlank()) return
        val pending = goAsync()
        Thread {
            try {
                ApiClient(server, token).reportTamper(
                    type,
                    "${Build.MANUFACTURER} ${Build.MODEL}: $action — likely a manual removal or app uninstall in progress.",
                )
            } catch (e: Exception) {
                // Best-effort: network may be unreachable at the exact moment of
                // disable. Nothing more we can do from here.
            } finally {
                pending.finish()
            }
        }.start()
    }

    override fun onPasswordFailed(context: Context, intent: Intent) {
        // A failed unlock attempt is a monitoring signal; surfaced to the server
        // via the normal check-in on the next cycle.
    }

    companion object {
        // Keys read from the provisioning QR's admin-extras bundle.
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_ENROLL_TOKEN = "enrollment_token"

        fun componentName(context: Context): ComponentName =
            ComponentName(context.applicationContext, SentroidDeviceAdminReceiver::class.java)
    }
}
