package com.pogotxk.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * The app shell.
 *
 * The site already is the UI — this hosts it in a WebView and adds the one
 * thing a browser cannot do: the floating bubble. Signing in happens through
 * the same Discord flow as the website, and the resulting session cookie is
 * what the bubble uses, so there is no second credential to manage or leak.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /**
     * Origin of the page currently loaded, kept so the bridge can refuse calls
     * from anything that is not our own site. Written on the UI thread when a
     * page finishes, read from the WebView's binder thread.
     */
    @Volatile
    private var loadedOrigin: String? = null

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val requestLocation =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    private val requestOverlay =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            // The system dialog does not report a result, so re-check directly.
            if (canDrawOverlays()) startBubble() else toast("Permission not granted")
            refreshButton()
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        /*
         * The site fills the window now.
         *
         * There used to be a native "Allow the floating bubble" button bolted
         * across the top. It was unreachable in practice — the layout draws
         * from the top of the window and nothing insets it, so on a phone with
         * a status bar over the content the button sat underneath and could not
         * be tapped. It was also the wrong place for it: nobody looks above the
         * page for a control that belongs on the page. `BubbleControl` on /go
         * replaces it entirely, and `fitsSystemWindows` keeps the site's own
         * header out from under the status bar the same way.
         */
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
        }

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            /*
             * Marks our shell so the server can tell it apart from a phone
             * browser. /auth/login shows phones a "continue with Discord"
             * interstitial, because a browser will not hand a redirect to a
             * native app and only a real tap gets routed. In here that tap
             * would be wasted — shouldOverrideUrlLoading already intercepts the
             * authorize URL and hands it over directly.
             */
            settings.userAgentString = "${settings.userAgentString} PogoTxkApp/1"
            // Geolocation inside the WebView drives the site's "nearest gym"
            // logic; the bubble uses the native location APIs instead.
            settings.setGeolocationEnabled(true)

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): Boolean {
                    val url = request?.url ?: return false
                    val host = url.host.orEmpty()

                    /*
                     * The authorize screen goes to the Discord app, not in here.
                     *
                     * Loading it in the WebView was the reason signing in asked
                     * for a password every time: this WebView has its own cookie
                     * jar, Discord has never seen it, so Discord quite correctly
                     * showed a login form — while the trainer's phone had them
                     * signed in the whole time, one app away. Handing the URL to
                     * Android lets the Discord app claim it and show its own
                     * "authorize PoGo TXK?" sheet against the existing session.
                     */
                    if (host.endsWith("discord.com") && url.path.orEmpty().startsWith("/oauth2/authorize")) {
                        return handOffToDiscord(url)
                    }

                    // Everything else on our own hosts, and the rest of Discord's
                    // flow, stays in here; anything genuinely external opens in a
                    // real browser.
                    val internal = host.endsWith("workers.dev") ||
                        host.endsWith("pokemontxk.com") ||
                        host.endsWith("discord.com")
                    if (internal) return false
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    CookieManager.getInstance().flush()
                    loadedOrigin = url?.let { runCatching { Uri.parse(it) } .getOrNull() }
                        ?.let { "${it.scheme}://${it.authority}" }
                    refreshButton()
                }
            }
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.addJavascriptInterface(BubbleBridge(), BRIDGE_NAME)
        layout.addView(webView)

        setContentView(layout)
        installBackHandler()
        // Cold-started by the OAuth callback rather than the launcher icon: go
        // straight to the callback so the sign-in finishes, instead of loading
        // /go and silently dropping the code.
        webView.loadUrl(callbackUrlFrom(intent) ?: "${Api.ORIGIN}/go")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        maybeAskForLocation()

        refreshButton()
    }

    override fun onResume() {
        super.onResume()
        refreshButton()
    }

    /**
     * The Discord app sent the trainer back.
     *
     * `singleTask` means we are handed the callback here rather than getting a
     * second copy of the activity, which is what we want: the WebView holding
     * the state and PKCE cookies is right here, and it is the only thing that
     * can complete the exchange.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        callbackUrlFrom(intent)?.let { webView.loadUrl(it) }
    }

    /** The OAuth callback URL, if this intent is one. */
    private fun callbackUrlFrom(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (intent.action != Intent.ACTION_VIEW) return null
        val origin = "${data.scheme}://${data.authority}"
        if (origin != Api.ORIGIN || data.path != CALLBACK_PATH) return null
        return data.toString()
    }

    /**
     * Hands the authorize screen to the Discord app, falling back gracefully.
     *
     * Three rungs, because the goal is "never make them type a password", and
     * each rung is a weaker version of that rather than a different feature:
     *
     *  1. A non-browser handler — the Discord app. It approves against the
     *     session already on the phone, which is the whole point.
     *  2. Any handler, meaning a real browser. Chrome usually carries a Discord
     *     session too, so this still normally avoids a password.
     *  3. Our own WebView, the old behaviour. Always asks for a password, but a
     *     sign-in that is annoying beats one that is impossible.
     */
    private fun handOffToDiscord(url: Uri): Boolean {
        val view = Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val nonBrowser = Intent(view).addFlags(Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER)
            try {
                startActivity(nonBrowser)
                return true
            } catch (_: ActivityNotFoundException) {
                // No native handler — the Discord app is not installed, or this
                // device does not let it claim the link. Fall through.
            }
        }

        return try {
            startActivity(view)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    /**
     * Back navigates the WebView first, so "back" means what it means in a
     * browser. Registered through the dispatcher rather than overriding
     * onBackPressed, which is deprecated and ignored under predictive back.
     */
    private fun installBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    /**
     * Google Play's Location policy requires a "prominent disclosure" — an
     * in-app screen, before the system dialog, that names the data, the feature
     * it serves, and the fact that it is collected in the background. The OS
     * permission sheet does not satisfy this on its own, and shipping without it
     * is one of the more common location-policy rejections.
     *
     * Shown once. If the user declines we never ask again from here; Android's
     * own dialog remains the way back in, and flares degrade to not naming a gym
     * rather than failing.
     */
    private fun maybeAskForLocation() {
        if (Nearby.hasLocationPermission(this)) return

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (prefs.getBoolean(KEY_LOCATION_DISCLOSED, false)) return

        AlertDialog.Builder(this)
            .setTitle(R.string.location_rationale_title)
            .setMessage(R.string.location_rationale_body)
            .setCancelable(false)
            .setPositiveButton(R.string.location_rationale_continue) { _, _ ->
                prefs.edit().putBoolean(KEY_LOCATION_DISCLOSED, true).apply()
                requestLocation.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                        Manifest.permission.ACCESS_FINE_LOCATION,
                    )
                )
            }
            .setNegativeButton(R.string.location_rationale_skip) { _, _ ->
                prefs.edit().putBoolean(KEY_LOCATION_DISCLOSED, true).apply()
            }
            .show()
    }

    private fun canDrawOverlays(): Boolean = Settings.canDrawOverlays(this)

    /**
     * Debug builds may raise the bubble without a session, so the overlay can be
     * exercised on an emulator where the Discord round trip is impractical.
     * Firing a flare still requires auth — the service checks separately.
     */
    private fun bubbleAllowed(): Boolean = Api.isSignedIn() || BuildConfig.DEBUG

    /**
     * The page owns the control now, so "refresh" means telling the page.
     *
     * Kept as a named step rather than inlined because several unrelated things
     * change this state — a page load, returning from the overlay settings
     * screen, the service starting or stopping — and every one of them has to
     * end up here or the page shows the trainer something that is no longer true.
     */
    private fun refreshButton() {
        notifyPage()
    }

    /** The native button is a toggle; the bridge calls the halves directly. */
    private fun onBubbleButton() {
        if (BubbleService.isRunning) stopBubble() else requestBubbleOn()
    }

    private fun requestBubbleOn() {
        if (!bubbleAllowed()) {
            toast("Sign in with Discord first")
            return
        }
        if (!canDrawOverlays()) {
            // Android will not grant this silently — it has to be the system
            // screen, and the user has to flip it themselves.
            requestOverlay.launch(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName"),
                )
            )
            return
        }
        startBubble()
    }

    private fun startBubble() {
        BubbleService.start(this)
        toast("Bubble on — it stays put over other apps")
        refreshButton()
        moveTaskToBack(true)
    }

    private fun stopBubble() {
        BubbleService.stop(this)
        toast("Bubble off")
        refreshButton()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    // ---------------------------------------------------------------- bridge --

    /** Tells the page its view of the bubble may be out of date. */
    private fun notifyPage() {
        if (!::webView.isInitialized) return
        runCatching {
            webView.evaluateJavascript("window.dispatchEvent(new Event('$STATE_EVENT'))", null)
        }
    }

    /**
     * Whether the page making a bridge call is actually ours.
     *
     * This matters more than it looks. `addJavascriptInterface` injects the
     * object into **every** page and every frame the WebView loads, and this
     * WebView deliberately loads `discord.com` so the OAuth round trip can
     * finish in place. Without this check, Discord's pages — or anything they
     * embed — could read whether the trainer is signed in and raise an overlay
     * on their behalf. There is no way to scope the interface to one origin, so
     * the check has to happen on the way in.
     */
    private fun isOurPage(): Boolean = loadedOrigin == Api.ORIGIN

    /**
     * The bridge the site uses to raise the ball.
     *
     * A web page cannot start an Android service on its own — no API exists,
     * in any browser — so this is the only way the control can live where
     * people look for it, which is on `/go` next to everything else. In an
     * ordinary browser the object is simply absent and the site renders
     * nothing, which is the correct outcome rather than a broken button.
     *
     * Every method runs on a binder thread, not the UI thread, so anything
     * touching views hops across explicitly.
     */
    private inner class BubbleBridge {

        /**
         * A JSON snapshot, read straight from sources that are safe off the UI
         * thread: the cookie store, an AppOps query, and the service's own
         * volatile flag. Deliberately not a UI-thread round trip — blocking a
         * binder thread on the main looper deadlocks if the page ever calls
         * this from a JS bridge callback.
         */
        @JavascriptInterface
        fun state(): String {
            if (!isOurPage()) return "{}"
            return JSONObject()
                .put("signedIn", Api.isSignedIn())
                .put("canOverlay", canDrawOverlays())
                .put("running", BubbleService.isRunning)
                .toString()
        }

        /**
         * Same entry point as the native button, so the permission prompt, the
         * sign-in refusal and the drop-to-background all behave identically
         * however the trainer got here.
         */
        @JavascriptInterface
        fun start() {
            runOnUiThread { if (isOurPage()) requestBubbleOn() }
        }

        @JavascriptInterface
        fun stop() {
            runOnUiThread { if (isOurPage()) stopBubble() }
        }
    }

    private companion object {
        const val PREFS = "app"
        const val KEY_LOCATION_DISCLOSED = "location_disclosed"

        /** What the site feature-detects on `window`. */
        const val BRIDGE_NAME = "PogoTxkApp"

        /** Dispatched on `window` when the bubble's state may have changed. */
        const val STATE_EVENT = "pogotxk-bubble"

        /** The OAuth redirect path this app claims — must match the manifest. */
        const val CALLBACK_PATH = "/auth/callback"
    }
}
