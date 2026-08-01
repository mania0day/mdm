package com.sentroid.agent

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.sentroid.agent.admin.SentroidDeviceAdminReceiver
import com.sentroid.agent.data.Prefs
import com.sentroid.agent.databinding.ActivityMainBinding
import com.sentroid.agent.policy.PolicyManager
import com.sentroid.agent.service.SentroidService
import com.sentroid.agent.util.DeviceInfo

/**
 * Enrollment + status screen. Guides the operator through:
 *   1) activating device administration, then
 *   2) enrolling the device against the SENTROID server with a token.
 * After enrollment the background service takes over check-ins and command
 * execution.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs
    private lateinit var policy: PolicyManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = Prefs(this)
        policy = PolicyManager(this)

        if (prefs.serverUrl.isEmpty()) prefs.serverUrl = BuildConfig.DEFAULT_SERVER
        binding.serverInput.setText(prefs.serverUrl)

        requestRuntimePermissions()

        binding.adminButton.setOnClickListener { activateDeviceAdmin() }
        binding.enrollButton.setOnClickListener { enroll() }
        binding.checkinButton.setOnClickListener {
            SentroidService.start(this)
            toast("Service running — check-in on next cycle")
        }
        binding.unenrollButton.setOnClickListener { unenroll() }

        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val adminActive = policy.isAdminActive()
        val sb = StringBuilder()
        sb.append("Device      : ${DeviceInfo.manufacturer()} ${DeviceInfo.model()}\n")
        sb.append("Android     : ${DeviceInfo.osVersion()} (API ${DeviceInfo.sdkInt()})\n")
        sb.append("Device UID  : ${prefs.deviceUid}\n")
        sb.append("Admin active: ${if (adminActive) "YES ✓" else "NO ✗"}\n")
        sb.append("Enrolled    : ${if (prefs.isEnrolled) "YES ✓ (id ${prefs.deviceId})" else "NO ✗"}")
        binding.statusText.text = sb.toString()

        binding.adminButton.isEnabled = !adminActive
        binding.adminButton.text =
            if (adminActive) "1 · Device Administration Active ✓" else "1 · Activate Device Administration"

        val enrolled = prefs.isEnrolled
        binding.checkinButton.visibility = if (enrolled) android.view.View.VISIBLE else android.view.View.GONE
        binding.unenrollButton.visibility = if (enrolled) android.view.View.VISIBLE else android.view.View.GONE
        binding.enrollButton.text = if (enrolled) "Re-enroll Device" else "2 · Enroll Device"
    }

    private fun activateDeviceAdmin() {
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(
                DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                SentroidDeviceAdminReceiver.componentName(this@MainActivity),
            )
            putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "SENTROID requires device administration to enforce security policy and " +
                    "perform authorized remote actions (lock, wipe, policy enforcement).",
            )
        }
        startActivity(intent)
    }

    private fun enroll() {
        val server = binding.serverInput.text.toString().trim().ifEmpty { BuildConfig.DEFAULT_SERVER }
        val token = binding.tokenInput.text.toString().trim()
        if (token.isEmpty()) {
            toast("Enter an enrollment token")
            return
        }
        if (!policy.isAdminActive()) {
            toast("Activate device administration first (step 1)")
            return
        }
        prefs.serverUrl = server
        log("Enrolling against $server …")
        binding.enrollButton.isEnabled = false

        Thread {
            val err = com.sentroid.agent.data.EnrollmentManager.enroll(this, server, token)
            runOnUiThread {
                if (err == null) {
                    log("Enrolled successfully as device #${prefs.deviceId}")
                    toast("Device enrolled ✓")
                    SentroidService.start(this)
                } else {
                    log("Enrollment failed: $err")
                    toast("Enrollment failed: $err")
                }
                binding.enrollButton.isEnabled = true
                refreshStatus()
            }
        }.start()
    }

    private fun unenroll() {
        prefs.clearEnrollment()
        com.sentroid.agent.service.CheckinScheduler.cancel(this)
        stopService(Intent(this, SentroidService::class.java))
        log("Unenrolled locally. Server still lists this device until deregistered.")
        refreshStatus()
    }

    private fun requestRuntimePermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 42)
        }
    }

    private fun log(msg: String) {
        binding.logText.text = msg
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
