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
    val intervalSeconds: Int,
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

    fun checkin(body: JSONObject): CheckinResult {
        val res = post("/api/agent/checkin", body, auth = true)
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
        return CheckinResult(
            commands = commands,
            policy = res.optJSONObject("policy"),
            compliance = res.optString("compliance", "unknown"),
            intervalSeconds = res.optInt("checkin_interval_seconds", 10),
        )
    }

    fun reportResult(commandId: Int, status: String, result: String) {
        val body = JSONObject().put("status", status).put("result", result)
        post("/api/agent/commands/$commandId/result", body, auth = true)
    }

    private fun post(path: String, body: JSONObject, auth: Boolean): JSONObject {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
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
