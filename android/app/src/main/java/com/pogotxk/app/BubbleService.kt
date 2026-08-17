package com.pogotxk.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The floating bubble.
 *
 * A foreground service owning a `TYPE_APPLICATION_OVERLAY` window, so it stays
 * put while Pokémon GO is in the foreground. That is the entire point: Android
 * is the only platform where a third-party app may draw over another one, and
 * this is the API that allows it.
 *
 * It never touches the game. No screen capture, no accessibility service, no
 * reading of another app's state — it is a shortcut that talks to our own
 * server, no different in kind from a Messenger chat head.
 */
class BubbleService : Service() {

    private lateinit var windowManager: WindowManager
    private var root: FrameLayout? = null
    private var params: WindowManager.LayoutParams? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** Cached so a tap does not wait on the network to find the nearest gym. */
    private var pois: List<Api.Poi> = emptyList()

    private var expanded = false
    private var busy = false

    /**
     * Where the window sits when only the ball is showing.
     *
     * Opening a panel on the right-hand side moves the whole window left (see
     * [anchorRight]), so the collapsed position has to be remembered rather
     * than recomputed — otherwise closing the panel would leave the ball
     * stranded wherever the expanded window happened to start.
     */
    private var collapsedX: Int? = null

    private data class Action(
        val emoji: String,
        val label: String,
        val kind: String,
        val poiTypes: Set<String>,
    )

    private val actions = listOf(
        Action("🔥", "Raid", "raid", setOf("gym")),
        Action("📣", "Invites", "remote_invites", setOf("gym")),
        Action("👋", "Here", "meetup_here", setOf("gym", "pokestop", "powerspot")),
    )

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        startForegroundCompat()
        addBubble()
        warmPoiCache()
        isRunning = true
    }

    /**
     * Declares the service types at runtime, because declaring `location`
     * unconditionally is a crash.
     *
     * From Android 14, starting a foreground service typed `location` without
     * the runtime location permission throws SecurityException — so a user who
     * taps "no thanks" on the location prompt would find the bubble simply
     * refusing to start, with no explanation. We drop to `specialUse` alone in
     * that case: the ball still works, flares still send, they just do not name
     * a gym. Degrading is the correct behaviour for a permission the feature can
     * live without.
     */
    private fun startForegroundCompat() {
        val notification = buildNotification()
        // Only API 34 introduced both `specialUse` and the SecurityException
        // this guards against. Below it the two-argument call adopts whatever
        // the manifest declares, which is what we want and cannot throw.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification)
            return
        }
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (Nearby.hasLocationPermission(this)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        startForeground(NOTIFICATION_ID, notification, types)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Sticky: if Android kills us under pressure the bubble should come back,
        // since the user explicitly turned it on.
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        root?.let { runCatching { windowManager.removeView(it) } }
        root = null
        scope.cancel()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- notif --

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Quick actions bubble",
                    // Low: this notification exists because Android requires one
                    // for a foreground service, not because it has anything to say.
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { setShowBadge(false) }
            )
        }

        val stop = PendingIntent.getService(
            this,
            0,
            Intent(this, BubbleService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("PoGo TXK bubble is on")
            .setContentText("Tap the bubble to flare a gym")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Turn off", stop).build())
            .build()
    }

    // --------------------------------------------------------------- bubble --

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics)
            .toInt()

    private fun addBubble() {
        val container = FrameLayout(this)

        val ball = ImageView(this).apply {
            setImageResource(R.drawable.ic_bubble_ball)
            val size = dp(56)
            layoutParams = FrameLayout.LayoutParams(size, size)
            elevation = dp(6).toFloat()
            contentDescription = getString(R.string.bubble_content_description)
        }
        container.addView(ball)

        val layout = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            // NOT_FOCUSABLE keeps the game underneath receiving input; without it
            // the overlay would swallow the keyboard and back button.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // Where the user last pinned it. The default is the RIGHT edge, not
            // the left: this thing lives next to a game played with the thumb,
            // and most people are right-handed.
            val saved = prefs()
            x = saved.getInt(KEY_X, screenWidth() - dp(56) - EDGE_MARGIN_DP.let(::dp))
            y = saved.getInt(KEY_Y, dp(160))
        }

        ball.setOnTouchListener(dragAndTapListener(layout))

        windowManager.addView(container, layout)
        root = container
        params = layout

        // The saved position may have been written in a different orientation,
        // or on a different display entirely if the phone has been docked since.
        // Snapping once on creation re-resolves it against the screen we
        // actually have, so the ball can never come back off-screen.
        snapAndPersist(layout)
    }

    /**
     * Puts the ball back on a real edge after a rotation.
     *
     * Rotating swaps the screen's width and height, but an overlay window keeps
     * the x/y it was last given — in the *old* orientation's coordinates. A ball
     * parked on the right edge in landscape lands far off the right edge in
     * portrait, where it cannot be tapped, dragged back, or reached at all. And
     * because the position is persisted, turning the bubble off and on again
     * would restore the same unreachable coordinates rather than recover it.
     *
     * A service only receives this callback for the configuration changes it
     * survives, which is exactly the case that matters here.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val layout = params ?: return
        // An open panel was measured against the previous screen width, so its
        // anchoring is meaningless now. Close it and let the next tap rebuild it.
        if (expanded) collapse()
        snapAndPersist(layout)
    }

    // ------------------------------------------------------------- position --

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * The real display bounds, not the app's usable area.
     *
     * The window carries `FLAG_LAYOUT_NO_LIMITS`, so its x/y are in full-display
     * coordinates including the system bars. `displayMetrics` reports the area
     * *minus* those bars on some versions, and clamping full-display coordinates
     * against a smaller rectangle parks the ball short of the edge on some
     * devices and lets it sit under the status bar on others.
     */
    private fun screenWidth(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.currentWindowMetrics.bounds.width()
        } else {
            @Suppress("DEPRECATION")
            resources.displayMetrics.widthPixels
        }

    private fun screenHeight(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.currentWindowMetrics.bounds.height()
        } else {
            @Suppress("DEPRECATION")
            resources.displayMetrics.heightPixels
        }

    /**
     * Snaps to whichever side edge is nearer and remembers it.
     *
     * "Pin it wherever you like" is the ask, but a free-floating bubble parked
     * mid-screen sits on top of whatever you are trying to tap in the game. The
     * edges are the only places it is reliably out of the way, so a release
     * always resolves to one of them — the user chooses the side and the height,
     * and we take responsibility for it not covering anything.
     *
     * Y is clamped so the ball can never be dragged half off the top or bottom
     * and become impossible to grab again.
     */
    private fun snapAndPersist(layout: WindowManager.LayoutParams) {
        val size = dp(56)
        val margin = dp(EDGE_MARGIN_DP)
        val leftEdge = margin
        val rightEdge = screenWidth() - size - margin

        layout.x = if (layout.x + size / 2 < screenWidth() / 2) leftEdge else rightEdge
        layout.y = layout.y.coerceIn(margin, screenHeight() - size - margin)

        runCatching { windowManager.updateViewLayout(root, layout) }
        prefs().edit().putInt(KEY_X, layout.x).putInt(KEY_Y, layout.y).apply()
    }

    /**
     * Distinguishes a drag from a tap.
     *
     * Without a movement threshold the bubble is unusable: a thumb always slides
     * a few pixels, so every tap would register as a drag and nothing would ever
     * open.
     */
    private fun dragAndTapListener(layout: WindowManager.LayoutParams): View.OnTouchListener {
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var dragging = false
        val slop = dp(8)

        return View.OnTouchListener { view, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    startX = layout.x
                    startY = layout.y
                    dragging = false
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) {
                        dragging = true
                        // Moving the ball moves the whole window, and an open
                        // panel has shifted that window away from the ball's
                        // collapsed position. Dragging from there would persist
                        // the panel's offset as the ball's home. Closing first
                        // restores the true position, and it matches what every
                        // other chat head does: drag it and the menu goes away.
                        if (expanded) collapse()
                        startX = layout.x
                        startY = layout.y
                        downX = event.rawX
                        downY = event.rawY
                    }
                    if (dragging) {
                        layout.x = startX + (event.rawX - downX).toInt()
                        layout.y = startY + (event.rawY - downY).toInt()
                        runCatching { windowManager.updateViewLayout(root, layout) }
                    }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        snapAndPersist(layout)
                    } else {
                        view.performClick()
                        toggleExpanded()
                    }
                    true
                }

                /**
                 * The gesture was taken away mid-drag.
                 *
                 * This is the branch that matters for a bubble living over
                 * another app: the shade being pulled down, a system dialog
                 * appearing, an OEM edge gesture claiming the pointer — any of
                 * them ends the stream with CANCEL and no UP will follow. The
                 * old `else -> false` swallowed it, leaving `dragging` true and
                 * the ball abandoned wherever the finger was: not snapped to an
                 * edge, not saved, and quite possibly sitting on top of the
                 * thing the user was trying to tap in the game. A cancelled
                 * gesture is not a tap, so it must never open the panel.
                 */
                MotionEvent.ACTION_CANCEL -> {
                    if (dragging) snapAndPersist(layout)
                    dragging = false
                    true
                }

                else -> false
            }
        }
    }

    /** True when the ball is parked on the left half, so a panel may grow right. */
    private fun ballOnLeftHalf(): Boolean =
        (collapsedX ?: params?.x ?: 0) + dp(56) / 2 < screenWidth() / 2

    /**
     * A panel beside the ball, laid out so it grows inward.
     *
     * When the ball is on the left the panel sits to its right, and the frame is
     * the ball plus a gap plus the panel. When the ball is on the right the two
     * swap: the panel takes the start of the frame and the ball is pushed to the
     * end by [anchorRight], so the row reads panel-then-ball.
     */
    private fun panelShell(onLeftHalf: Boolean): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setColor(PANEL_BACKGROUND)
            }
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(4)
                // Either way the margin reserves the ball's 56dp plus a gap; the
                // difference is only which end of the frame it is reserved at.
                if (onLeftHalf) leftMargin = dp(64) else rightMargin = dp(64)
            }
        }
    }

    /**
     * Moves the *window* left so a right-edge panel stays on screen.
     *
     * This is the part the old layout-only approach could not do. The window is
     * `WRAP_CONTENT` anchored `TOP|START` at the ball's x, so adding a panel
     * grows it rightwards from that x — and with the ball on the right edge,
     * which is the default side, that growth runs straight off the display.
     * `FLAG_LAYOUT_NO_LIMITS` means the window manager will not clamp it back,
     * so the panel simply is not there to tap. Setting `Gravity.END` on the
     * panel could never fix it: that positions the panel *within* the window,
     * and it is the window itself that is off-screen.
     *
     * So the window's right edge is pinned level with the ball's right edge and
     * it is allowed to extend leftwards instead, with the ball moved to the end
     * of the frame so it does not appear to jump inward.
     */
    private fun anchorRight(container: FrameLayout, layout: WindowManager.LayoutParams) {
        val unspecified = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        container.measure(unspecified, unspecified)
        val width = container.measuredWidth
        if (width <= dp(56)) return

        (container.getChildAt(0).layoutParams as FrameLayout.LayoutParams).gravity =
            Gravity.END or Gravity.TOP
        container.getChildAt(0).requestLayout()

        val anchor = collapsedX ?: layout.x
        layout.x = (anchor + dp(56) - width).coerceAtLeast(dp(EDGE_MARGIN_DP))
        runCatching { windowManager.updateViewLayout(container, layout) }
    }

    /** Shows a freshly built panel and keeps it on screen. */
    private fun present(panel: LinearLayout, onLeftHalf: Boolean) {
        val container = root ?: return
        val layout = params ?: return
        collapsedX = layout.x
        container.addView(panel)
        expanded = true
        if (!onLeftHalf) anchorRight(container, layout)
    }

    private fun toggleExpanded() {
        if (expanded) {
            collapse()
            return
        }

        val onLeftHalf = ballOnLeftHalf()
        val panel = panelShell(onLeftHalf)
        actions.forEach { action -> panel.addView(actionChip(action)) }
        panel.addView(closeChip())

        present(panel, onLeftHalf)
    }

    /**
     * Step two: name what is about to happen, and make the user agree to it.
     *
     * Justin's call, and it is the right one for this surface specifically. The
     * bubble is designed to be pressed without looking, while a game has your
     * attention — which is exactly the condition under which a mis-tap happens.
     * A flare is not a local action: it posts to Discord and pushes to every
     * member's phone. An undo would have been a race against a notification that
     * has already arrived, so a confirmation that names the gym is strictly
     * better than a window to take it back.
     *
     * It also earns its keep when nothing is wrong: "Raid at Bramlet Field" is
     * the moment you find out the bubble picked the gym you actually meant.
     */
    private fun confirmPanel(action: Action, poi: Api.Poi?) {
        if (root == null) return
        collapse()

        val onLeftHalf = ballOnLeftHalf()
        val panel = panelShell(onLeftHalf)

        panel.addView(
            TextView(this).apply {
                text = if (poi != null) "${action.label} · ${poi.name}" else "${action.label} · location unknown"
                setTextColor(Color.WHITE)
                textSize = 13f
                maxWidth = dp(150)
                maxLines = 2
                setPadding(dp(6), 0, dp(8), 0)
            }
        )
        panel.addView(chip("✓") { send(action, poi) })
        panel.addView(chip("✕") { collapse() })

        present(panel, onLeftHalf)
    }

    /**
     * Removes the panel and puts the window back where the ball lives.
     *
     * The x restore is not cosmetic: [anchorRight] moved the whole window left
     * to fit the panel, so without undoing it the ball would stay at the
     * panel's far corner and every later position — including the one written
     * to disk — would drift further inward each time it was opened.
     */
    private fun collapse() {
        val container = root ?: return
        // Child 0 is the bubble itself; anything after it is the panel.
        while (container.childCount > 1) container.removeViewAt(1)
        expanded = false

        val layout = params
        val restore = collapsedX
        collapsedX = null
        if (layout == null || restore == null) return

        (container.getChildAt(0).layoutParams as FrameLayout.LayoutParams).gravity =
            Gravity.START or Gravity.TOP
        container.getChildAt(0).requestLayout()
        layout.x = restore
        runCatching { windowManager.updateViewLayout(container, layout) }
    }

    private fun chip(text: String, onTap: () -> Unit): TextView = TextView(this).apply {
        this.text = text
        textSize = 20f
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        val size = dp(48)
        layoutParams = LinearLayout.LayoutParams(size, size).apply { marginEnd = dp(4) }
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#1C4675"))
        }
        setOnClickListener { onTap() }
    }

    private fun actionChip(action: Action): TextView = chip(action.emoji) { prepare(action) }

    private fun closeChip(): TextView = chip("✕") { collapse() }

    // ------------------------------------------------------------- actions --

    private fun warmPoiCache() {
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { Api.fetchPois() } }
                .onSuccess { pois = it }
        }
    }

    /**
     * Step one: work out WHERE, then ask. Nothing leaves the phone here.
     *
     * The lookup runs before the confirmation rather than after it so the
     * confirmation can name the gym — "Raid · Bramlet Field" is a question the
     * user can actually answer, where a bare "Send raid?" is not.
     */
    private fun prepare(action: Action) {
        if (busy) return
        if (!Api.isSignedIn()) {
            toast("Open PoGo TXK and sign in first")
            collapse()
            return
        }

        busy = true
        toast("Finding the nearest ${if ("gym" in action.poiTypes) "gym" else "stop"}…")

        scope.launch {
            try {
                if (pois.isEmpty()) pois = withContext(Dispatchers.IO) { Api.fetchPois() }
                val here = Nearby.currentLocation(this@BubbleService)
                confirmPanel(action, Nearby.nearest(pois, here, action.poiTypes))
            } catch (e: Exception) {
                toast(e.message ?: "Could not look that up")
                collapse()
            } finally {
                busy = false
            }
        }
    }

    /** Step two: the user said yes. This is the only path that posts. */
    private fun send(action: Action, poi: Api.Poi?) {
        if (busy) return
        busy = true
        collapse()
        toast("Sending ${action.label.lowercase()}…")

        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    Api.postFlare(kind = action.kind, poiId = poi?.id)
                }
                val sent = if (poi != null) "${action.label} sent — ${poi.name}" else "${action.label} sent"
                // The bubble never asks which boss — typing one here would turn a
                // one-tap alert into a form. The board already lets whoever raised
                // it add the boss afterwards (PATCH /api/flares/:id, action=edit),
                // so point at that instead of not saying anything.
                toast(if (action.kind == "raid") "$sent. Add the boss in the app." else sent)
            } catch (e: Exception) {
                toast(e.message ?: "Could not send")
            } finally {
                busy = false
            }
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        /**
         * Whether the overlay is up, so the page can render "Turn the bubble
         * off" instead of guessing.
         *
         * A service has no queryable running state worth relying on —
         * `getRunningServices` is deprecated and lies about your own process
         * often enough to matter — so the service reports its own lifecycle.
         * Volatile because it is written on the main thread and read from the
         * WebView's binder thread.
         */
        @Volatile
        var isRunning = false
            private set

        const val ACTION_STOP = "com.pogotxk.app.STOP_BUBBLE"
        private const val CHANNEL_ID = "bubble"
        private const val NOTIFICATION_ID = 1

        private const val PREFS = "bubble"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"

        /** How far the ball parks from the screen edge, in dp. */
        private const val EDGE_MARGIN_DP = 8

        /** Brand red at ~93% — opaque enough to read over a bright game scene. */
        private val PANEL_BACKGROUND = Color.parseColor("#EEC8071C")

        fun start(context: Context) {
            context.startForegroundService(Intent(context, BubbleService::class.java))
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, BubbleService::class.java).setAction(ACTION_STOP)
            )
        }
    }
}
