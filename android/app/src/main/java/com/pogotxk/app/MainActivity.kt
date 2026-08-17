package com.pogotxk.app

import android.Manifest
import android.annotation.SuppressLint
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
    private lateinit var bubbleButton: Button

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

        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        bubbleButton = Button(this).apply {
            setOnClickListener { onBubbleButton() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        layout.addView(bubbleButton)

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Geolocation inside the WebView drives the site's "nearest gym"
            // logic; the bubble uses the native location APIs instead.
            settings.setGeolocationEnabled(true)

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): Boolean {
                    val url = request?.url ?: return false
                    // Discord's OAuth screens have to load in here for sign-in to
                    // complete; anything else external goes to a real browser.
                    val host = url.host.orEmpty()
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
        webView.loadUrl("${Api.ORIGIN}/go")

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

    private fun refreshButton() {
        bubbleButton.text = when {
            !bubbleAllowed() -> "Sign in below to enable the bubble"
            !canDrawOverlays() -> "Allow the floating bubble"
            BubbleService.isRunning -> "Turn the bubble off"
            else -> "Turn the bubble on"
        }
        bubbleButton.isEnabled = bubbleAllowed()
        // The page renders its own copy of this state, so anything that moves
        // the native button has to tell the page too or the two disagree.
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
    }
}
