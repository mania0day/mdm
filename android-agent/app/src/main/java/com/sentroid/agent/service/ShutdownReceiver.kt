package com.sentroid.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.sentroid.agent.data.ApiClient
import com.sentroid.agent.data.Prefs

/**
 * Report that this device is powering off, in the seconds before it goes dark.
 *
 * Why this exists: Android exposes NO way to prevent a shutdown. There is no
 * power-off API for a Device Owner to block, app overlays are force-hidden over
 * system dialogs (anti-tapjacking), and holding the power button triggers a
 * firmware-level shutdown that no software on a non-rooted device can intercept.
 * Powering the phone off is therefore the one guaranteed way for a user to take
 * a managed device off the network.
 *
 * Since it cannot be prevented, it is made ACCOUNTABLE: the OS broadcasts
 * ACTION_SHUTDOWN just before going down, and we spend that window telling the
 * server. Without this the console only ever learns "device went silent", which
 * is indistinguishable from a dead battery, no signal, or a pulled SIM. With it,
 * a deliberate power-off is a logged, alertable security event that the offline
 * monitor can then corroborate.
 *
 * Best-effort by nature: the shutdown window is short (single-digit seconds) and
 * the radio may already be down, so a failed send is expected and silent — the
 * existing offline monitor is the backstop.
 */
class ShutdownReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_SHUTDOWN && action != Intent.ACTION_REBOOT) return

        val prefs = Prefs(context)
        val server = prefs.serverUrl
        val token = prefs.deviceToken
        if (server.isBlank() || token.isNullOrBlank()) return

        // Distinguish an orderly reboot (the device is expected back) from a
        // power-off (it is not) — they mean very different things to an admin
        // looking at why a device stopped reporting.
        val isReboot = action == Intent.ACTION_REBOOT
        val type = if (isReboot) "DEVICE_REBOOTING" else "DEVICE_POWERING_OFF"
        val detail = if (isReboot) {
            "device is rebooting — it should check in again shortly"
        } else {
            "device is powering OFF — it will stop reporting until switched back on. " +
                "Android provides no way to block a shutdown, so this is reported rather than prevented."
        }

        val pending = goAsync()
        Thread {
            try {
                ApiClient(server, token).reportTamper(
                    type,
                    "${Build.MANUFACTURER} ${Build.MODEL}: $detail",
                )
            } catch (e: Exception) {
                // Expected: the network stack may already be torn down. The
                // server's offline monitor will notice the silence regardless.
            } finally {
                pending.finish()
            }
        }.start()
    }
}
