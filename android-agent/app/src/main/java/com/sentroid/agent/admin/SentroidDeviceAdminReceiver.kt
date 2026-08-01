package com.sentroid.agent.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import android.widget.Toast
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

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        return "Disabling SENTROID administration removes this device from secure management " +
            "and may violate organizational security policy."
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
