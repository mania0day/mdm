package com.sentroid.agent.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/** Result of an agent check-in: commands to run plus the current policy. */
data class CheckinResult(
    val commands: List<CommandDto>,
    val policy: JSONObject?,
    val compliance: String,
    /** Human-readable reasons the device is non-compliant, for display in-app. */
    val violations: List<String>,
    val intervalSeconds: Int,
    val allowReconfigure: Boolean,
)

data class CommandDto(val id: Int, val type: String, val payload: JSONObject)

class ApiException(val code: Int, message: String) : Exception(message)

/**
 * Minimal HTTP client for the SENTROID MDM API using HttpURLConnection so the
 * agent has no third-party networking dependencies. All calls are blocking and
 * must be invoked from a background thread.
 */
class ApiClient(private val baseUrl: String, private val deviceToken: String? = null) {

    fun enroll(body: JSONObject): JSONObject =
        post("/api/agent/enroll", body, auth = false)

    /**
     * @param holdSeconds how long the server may hold this request open waiting
     *   for a command (long-poll). 0 = return immediately (battery-friendly idle
     *   polling). When > 0 the read timeout is extended past the server's hold so
     *   the connection isn't torn down a moment before the server replies.
     */
    fun checkin(body: JSONObject, holdSeconds: Int = 0): CheckinResult {
        if (holdSeconds > 0) body.put("wait", holdSeconds)
        val readTimeout = if (holdSeconds > 0) holdSeconds * 1000 + 15000 else 15000
        val res = post("/api/agent/checkin", body, auth = true, readTimeoutMs = readTimeout)
        val cmdArr: JSONArray = res.optJSONArray("commands") ?: JSONArray()
        val commands = ArrayList<CommandDto>()
        for (i in 0 until cmdArr.length()) {
            val c = cmdArr.getJSONObject(i)
            commands.add(
                CommandDto(
                    id = c.getInt("id"),
                    type = c.getString("type"),
                    payload = c.optJSONObject("payload") ?: JSONObject(),
                ),
            )
        }
        val vioArr = res.optJSONArray("violations") ?: JSONArray()
        val violations = ArrayList<String>()
        for (i in 0 until vioArr.length()) vioArr.optString(i)?.takeIf { it.isNotBlank() }?.let { violations.add(it) }

        // optString() returns the literal string "null" when the JSON value is
        // an explicit null (it stringifies the NULL sentinel rather than falling
        // back), which would otherwise surface in the UI as "Status: null".
        val compliance = res.optString("compliance", "unknown")
            .takeIf { it.isNotBlank() && it != "null" } ?: "unknown"

        return CheckinResult(
            commands = commands,
            policy = res.optJSONObject("policy"),
            compliance = compliance,
            violations = violations,
            intervalSeconds = res.optInt("checkin_interval_seconds", 10),
            allowReconfigure = res.optBoolean("allow_reconfigure", false),
        )
    }

    fun reportResult(commandId: Int, status: String, result: String) {
        val body = JSONObject().put("status", status).put("result", result)
        post("/api/agent/commands/$commandId/result", body, auth = true)
    }

    /** Tell the server this device is leaving management; revokes its token server-side. */
    fun unenroll() {
        post("/api/agent/unenroll", JSONObject(), auth = true)
    }

    /** Best-effort tamper/self-report (e.g. device administration was just deactivated). */
    fun reportTamper(type: String, message: String) {
        val body = JSONObject().put("type", type).put("message", message)
        // Short timeouts on purpose: this is called from a BroadcastReceiver's
        // goAsync() window (onDisabled / onDisableRequested) during app teardown,
        // which the OS caps at ~10s before it may reap the process. A quick single
        // attempt (≤8s worst case) that fits inside that budget lands the report
        // far more reliably than the default 15s+15s call, which can be killed
        // mid-request on exactly the slow/offline network this path targets.
        post("/api/agent/tamper", body, auth = true, connectTimeoutMs = 4000, readTimeoutMs = 4000)
    }

    /**
     * Report policy breaches this device OBSERVED but did not block.
     *
     * This is the device half of 'monitor' mode. A monitored rule is deliberately
     * left un-blocked on the handset, so the breach leaves no trace in the OS, the
     * compliance verdict, or anywhere else — these rows are the only record it
     * ever happened. The same path carries breaches of rules set to 'enforce' that
     * this device is too old, or not Device Owner enough, to actually block.
     *
     * Each entry is {rule, mode, detail, metadata, occurred_at}; occurred_at is the
     * device clock at DETECTION, which is why it is sent at all — a phone that was
     * offline for an hour must report when the breach happened, not when it finally
     * managed to phone home (the server keeps its own created_at for that).
     *
     * The server accepts at most 50 violations per request and rejects the whole
     * batch above that, which is why ViolationMonitor caps its queue to match.
     * Throws like every other call here, so the caller can requeue the batch
     * instead of silently losing the evidence.
     */
    fun reportViolations(violations: List<JSONObject>) {
        if (violations.isEmpty()) return
        val arr = JSONArray()
        for (v in violations) arr.put(v)
        post("/api/agent/violations", JSONObject().put("violations", arr), auth = true)
    }

    /** Sync a dino-runner score; the server keeps only the best one seen. */
    fun submitGameScore(score: Int) {
        post("/api/agent/game-score", JSONObject().put("score", score), auth = true)
    }

    private fun post(
        path: String,
        body: JSONObject,
        auth: Boolean,
        connectTimeoutMs: Int = 15000,
        readTimeoutMs: Int = 15000,
    ): JSONObject {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            if (auth && deviceToken != null) {
                conn.setRequestProperty("Authorization", "Bearer $deviceToken")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
            if (code !in 200..299) {
                val msg = try {
                    JSONObject(text).optString("error", "HTTP $code")
                } catch (e: Exception) {
                    "HTTP $code"
                }
                throw ApiException(code, msg)
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
