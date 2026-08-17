package com.pogotxk.app

import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

/**
 * Discord sign-in that uses the Discord app the trainer already has.
 *
 * The problem this exists to solve: signing in used to load Discord's OAuth
 * screen inside our WebView, and that WebView has its own cookie jar which
 * Discord has never seen. So Discord asked for a password — every time — while
 * the trainer was signed in on the same phone, one app away.
 *
 * Handing the ordinary https authorize URL to Android does not fix it either.
 * Discord deliberately refuses to deep-link that endpoint to its app, because
 * once you are inside the app there is no way to return you to the browser tab
 * holding the rest of the flow.
 *
 * The supported route is a CUSTOM SCHEME redirect. It belongs to this app, so
 * there is no tab to return to and the handoff becomes possible. The scheme has
 * to be registered in Discord's Developer Portal and repeated byte for byte in
 * both the authorize request and the token exchange.
 *
 * The exchange itself happens on our server, not here: it needs the client
 * secret, and a secret shipped inside an APK is not a secret. The app posts the
 * code, gets a session cookie back, and installs it in the WebView — after
 * which the app is signed in exactly the way a browser would be.
 */
object Auth {

    /** Must match DISCORD_CLIENT_ID on the server and the manifest's scheme. */
    private const val CLIENT_ID = "1534670096256073778"

    /** Discord's required shape: `discord-<application id>:/authorize/callback`. */
    const val REDIRECT_URI = "discord-$CLIENT_ID:/authorize/callback"
    const val SCHEME = "discord-$CLIENT_ID"
    const val CALLBACK_PATH = "/authorize/callback"

    /** Same two scopes the website asks for; neither is a privileged intent. */
    private const val SCOPES = "identify guilds.members.read"

    private const val AUTHORIZE = "https://discord.com/oauth2/authorize"
    private const val TIMEOUT_MS = 12_000

    /** Base64url, no padding — what RFC 7636 requires and Discord expects. */
    private const val B64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    class AuthException(message: String) : Exception(message)

    /** One in-flight attempt. Held in memory only; a killed app just starts over. */
    data class Pending(val state: String, val verifier: String)

    private fun randomToken(bytes: Int): String {
        val buf = ByteArray(bytes)
        SecureRandom().nextBytes(buf)
        return Base64.encodeToString(buf, B64)
    }

    private fun challengeFor(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(digest, B64)
    }

    /**
     * Starts an attempt and returns the URL to open, plus the secrets to keep.
     *
     * PKCE is not optional here. Discord requires it for custom-scheme flows,
     * and the reason is exactly right: a custom scheme can be claimed by any app
     * that declares it, so the code alone must not be enough. The verifier never
     * leaves the device until it is presented alongside the code.
     */
    fun begin(): Pair<String, Pending> {
        val state = randomToken(16)
        val verifier = randomToken(32)

        val query = listOf(
            "client_id" to CLIENT_ID,
            "redirect_uri" to REDIRECT_URI,
            "response_type" to "code",
            "scope" to SCOPES,
            "state" to state,
            "code_challenge" to challengeFor(verifier),
            "code_challenge_method" to "S256",
        ).joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }

        return "$AUTHORIZE?$query" to Pending(state, verifier)
    }

    /**
     * Trades the code for a session and installs it in the WebView.
     *
     * The server answers with a real `Set-Cookie`, which is handed to the cookie
     * store as-is: the app never has to know the cookie's name, flags or
     * lifetime, so there is one fewer thing to keep in step between the APK and
     * the server.
     */
    suspend fun complete(code: String, verifier: String) = withContext(Dispatchers.IO) {
        val conn = (URL("${Api.ORIGIN}/api/auth/mobile").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            doOutput = true
        }

        try {
            val payload = JSONObject().put("code", code).put("verifier", verifier).toString()
            conn.outputStream.use { it.write(payload.toByteArray()) }

            val ok = conn.responseCode in 200..299
            val text = (if (ok) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""

            if (!ok) {
                val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw AuthException(
                    message?.takeIf { it.isNotBlank() } ?: "Sign-in failed (${conn.responseCode})"
                )
            }

            // Header names are case-insensitive and Set-Cookie is repeatable, so
            // match on the whole map rather than asking for one spelling of it.
            val cookies = conn.headerFields
                .filterKeys { it != null && it.equals("set-cookie", ignoreCase = true) }
                .values
                .flatten()
            if (cookies.isEmpty()) throw AuthException("Signed in, but no session was returned")

            val manager = CookieManager.getInstance()
            cookies.forEach { manager.setCookie(Api.ORIGIN, it) }
            manager.flush()
        } finally {
            conn.disconnect()
        }
    }
}
