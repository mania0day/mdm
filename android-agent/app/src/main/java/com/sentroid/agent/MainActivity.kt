package com.sentroid.agent

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.sentroid.agent.admin.SentroidDeviceAdminReceiver
import com.sentroid.agent.data.Prefs
import com.sentroid.agent.databinding.ActivityMainBinding
import com.sentroid.agent.game.GameActivity
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

    // Once enrolled, the technical setup UI (server URL, token, device
    // internals) is hidden in favor of a minimal identity+status view — an
    // IT technician can bring it back with "IT setup / re-configure".
    private var showTechnicalSetup = false

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
        binding.reconfigureButton.setOnClickListener {
            showTechnicalSetup = true
            refreshStatus()
        }
        binding.playGameButton.setOnClickListener {
            startActivity(Intent(this, GameActivity::class.java))
        }

        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val adminActive = policy.isAdminActive()
        val ownerMode = policy.isDeviceOwner()
        val mode = if (ownerMode) "Device Owner (full control)" else if (adminActive) "Device Admin (basic control)" else "None"
        val modeColor = when {
            ownerMode -> ContextCompat.getColor(this, R.color.accent)
            adminActive -> ContextCompat.getColor(this, R.color.amber)
            else -> ContextCompat.getColor(this, R.color.danger)
        }

        binding.statusRows.removeAllViews()
        addStatusRow("Device", "${DeviceInfo.manufacturer()} ${DeviceInfo.model()}")
        addStatusRow("Android", "${DeviceInfo.osVersion()} (API ${DeviceInfo.sdkInt()})")
        addStatusRow("Device UID", prefs.deviceUid)
        addStatusRow("Management", mode, modeColor)
        addStatusRow(
            "Enrolled",
            if (prefs.isEnrolled) "Yes  ·  id ${prefs.deviceId}" else "No",
            ContextCompat.getColor(this, if (prefs.isEnrolled) R.color.accent else R.color.danger),
        )
        prefs.lastPolicyJson?.let { json ->
            try {
                val p = org.json.JSONObject(json)
                addStatusSectionHeader("ASSIGNED POLICY")
                val keys = p.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    addStatusRow(k.replace('_', ' '), p.get(k).toString())
                }
            } catch (_: Exception) {
                // Malformed/absent — just skip the policy section.
            }
        }

        binding.adminButton.isEnabled = !adminActive
        binding.adminButton.text =
            if (adminActive) "1 · Device Administration Active ✓" else "1 · Activate Device Administration"

        val enrolled = prefs.isEnrolled
        // Server can revoke reconfigure access at any time; if it has (or
        // never granted it), never leave the technical view open.
        if (enrolled && !prefs.allowReconfigure) showTechnicalSetup = false
        val showSetup = !enrolled || showTechnicalSetup

        binding.identityCard.visibility = if (enrolled && !showTechnicalSetup) android.view.View.VISIBLE else android.view.View.GONE
        if (enrolled) {
            binding.identityName.text = prefs.ownerName?.takeIf { it.isNotBlank() } ?: "Enrolled Device"
            val complianceLabel = when (prefs.lastCompliance) {
                "compliant" -> "Compliant"
                "non_compliant" -> "Needs attention"
                else -> "Checking in…"
            }
            // Spell out *why* the device needs attention. A bare "Needs
            // attention" tells the user nothing they can act on.
            val reasons = prefs.lastViolations
            binding.identityStatus.text = if (prefs.lastCompliance == "non_compliant" && reasons.isNotEmpty()) {
                "Status: $complianceLabel\n" + reasons.joinToString("\n") { "• $it" }
            } else {
                "Status: $complianceLabel"
            }
        }

        binding.techStatusCard.visibility = if (showSetup) android.view.View.VISIBLE else android.view.View.GONE
        binding.setupCard.visibility = if (showSetup) android.view.View.VISIBLE else android.view.View.GONE
        binding.setupActionsGroup.visibility = if (showSetup) android.view.View.VISIBLE else android.view.View.GONE
        binding.reconfigureButton.visibility =
            if (enrolled && !showTechnicalSetup && prefs.allowReconfigure) android.view.View.VISIBLE else android.view.View.GONE

        binding.checkinButton.visibility = if (enrolled) android.view.View.VISIBLE else android.view.View.GONE
        binding.managedNotice.visibility = if (enrolled) android.view.View.VISIBLE else android.view.View.GONE
        binding.enrollButton.text = if (enrolled) "Re-enroll Device" else "2 · Enroll Device"
    }

    /** One label/value row in the technical status card, with a thin divider below it. */
    private fun addStatusRow(label: String, value: String, valueColor: Int? = null) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(7), 0, dp(7))
        }
        row.addView(
            TextView(this).apply {
                text = label
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                textSize = 13f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            },
        )
        row.addView(
            TextView(this).apply {
                text = value
                setTextColor(valueColor ?: ContextCompat.getColor(this@MainActivity, R.color.text_primary))
                textSize = 13f
                typeface = Typeface.MONOSPACE
                gravity = Gravity.END
            },
        )
        binding.statusRows.addView(row)
        binding.statusRows.addView(
            View(this).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1))
                setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.surface_border))
            },
        )
    }

    private fun addStatusSectionHeader(title: String) {
        binding.statusRows.addView(
            TextView(this).apply {
                text = title
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_muted))
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                letterSpacing = 0.08f
                setPadding(0, dp(14), 0, dp(4))
            },
        )
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

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

    private fun requestRuntimePermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.READ_PHONE_STATE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_FOREGROUND_PERMS)
        } else {
            requestBackgroundLocationIfNeeded()
        }
    }

    /**
     * Background location must be requested as its own step on Android 10+ —
     * bundling it with the foreground request either fails silently or (on 11+)
     * is rejected outright by the OS. Only asked once foreground location is
     * actually granted, and only if not already granted.
     */
    private fun requestBackgroundLocationIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
                REQ_BACKGROUND_LOCATION,
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_FOREGROUND_PERMS) {
            val locationGranted =
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED ||
                    ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED
            if (locationGranted) requestBackgroundLocationIfNeeded()
        }
    }

    private fun log(msg: String) {
        binding.logText.text = msg
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val REQ_FOREGROUND_PERMS = 42
        private const val REQ_BACKGROUND_LOCATION = 43
    }
}
