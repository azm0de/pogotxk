package com.pogotxk.app

import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The site's API, called with the session cookie the WebView already holds.
 *
 * Deliberately no separate auth: the user signs in once through Discord in the
 * WebView, and the bubble reuses that cookie. Building a second credential path
 * would mean a second thing to leak.
 *
 * Nothing here talks to Pokémon GO. It reads no screen, hooks no process and
 * mocks no location — it only posts to our own server. That line is what keeps
 * this on the right side of Niantic's terms, and it is not worth crossing.
 */
object Api {
    const val ORIGIN = "https://pogotxk.gnomelabz.workers.dev"

    private const val TIMEOUT_MS = 12_000

    data class Poi(val id: Int, val name: String, val type: String, val lat: Double, val lng: Double)

    class ApiException(message: String) : Exception(message)

    private fun cookieHeader(): String? = CookieManager.getInstance().getCookie(ORIGIN)

    /** True once the WebView has a session cookie for the site. */
    fun isSignedIn(): Boolean = cookieHeader()?.contains("pogotxk_session=") == true

    private fun open(path: String, method: String): HttpURLConnection {
        val conn = URL("$ORIGIN$path").openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = TIMEOUT_MS
        conn.readTimeout = TIMEOUT_MS
        conn.setRequestProperty("Accept", "application/json")
        // Astro rejects cross-site POSTs that look like form submissions; this
        // marks the request as an API call.
        conn.setRequestProperty("Content-Type", "application/json")
        cookieHeader()?.let { conn.setRequestProperty("Cookie", it) }
        return conn
    }

    private fun readBody(conn: HttpURLConnection): String {
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        return stream?.bufferedReader()?.use { it.readText() } ?: ""
    }

    private suspend fun request(path: String, method: String, body: String? = null): String =
        withContext(Dispatchers.IO) {
            val conn = open(path, method)
            try {
                if (body != null) {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray()) }
                }
                val text = readBody(conn)
                if (conn.responseCode !in 200..299) {
                    val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    throw ApiException(
                        message?.takeIf { it.isNotBlank() } ?: "Request failed (${conn.responseCode})"
                    )
                }
                text
            } finally {
                conn.disconnect()
            }
        }

    /** Every published POI, so the bubble can pick the nearest gym offline-ish. */
    suspend fun fetchPois(): List<Poi> {
        val json = JSONObject(request("/api/map.json", "GET"))
        val array: JSONArray = json.optJSONArray("pois") ?: return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                add(
                    Poi(
                        id = o.getInt("id"),
                        name = o.getString("name"),
                        type = o.getString("type"),
                        lat = o.getDouble("lat"),
                        lng = o.getDouble("lng"),
                    )
                )
            }
        }
    }

    /** Fire a flare. Returns the id the server assigned. */
    suspend fun postFlare(
        kind: String,
        poiId: Int?,
        boss: String? = null,
        needed: Int? = null,
        note: String? = null,
    ): Int {
        val payload = JSONObject().apply {
            put("kind", kind)
            if (poiId != null) put("poiId", poiId) else put("poiId", JSONObject.NULL)
            put("boss", boss ?: JSONObject.NULL)
            put("needed", needed ?: JSONObject.NULL)
            put("note", note ?: JSONObject.NULL)
        }
        val json = JSONObject(request("/api/flares", "POST", payload.toString()))
        return json.getJSONObject("flare").getInt("id")
    }
}
