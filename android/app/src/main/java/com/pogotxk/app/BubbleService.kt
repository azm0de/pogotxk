package com.pogotxk.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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
    }

    // ------------------------------------------------------------- position --

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun screenWidth(): Int = resources.displayMetrics.widthPixels

    private fun screenHeight(): Int = resources.displayMetrics.heightPixels

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
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
                    if (dragging) {
                        layout.x = startX + dx.toInt()
                        layout.y = startY + dy.toInt()
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

                else -> false
            }
        }
    }

    /**
     * A panel anchored beside the ball, on whichever side has room.
     *
     * The ball snaps to an edge, so a panel with a fixed left margin would open
     * straight off the screen whenever the ball is parked on the right — which
     * is now the default side. Anchoring by measured position instead means the
     * panel always opens inward.
     */
    private fun panelShell(): LinearLayout {
        val onLeftHalf = (params?.x ?: 0) + dp(56) / 2 < screenWidth() / 2
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
                if (onLeftHalf) {
                    leftMargin = dp(64)
                } else {
                    // Grows leftwards from the ball instead of off the edge.
                    gravity = Gravity.END
                    rightMargin = dp(64)
                }
            }
        }
    }

    private fun toggleExpanded() {
        val container = root ?: return
        if (expanded) {
            collapse()
            return
        }

        val panel = panelShell()
        actions.forEach { action -> panel.addView(actionChip(action)) }
        panel.addView(closeChip())

        container.addView(panel)
        expanded = true
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
        val container = root ?: return
        collapse()

        val panel = panelShell()

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

        container.addView(panel)
        expanded = true
    }

    private fun collapse() {
        val container = root ?: return
        // Child 0 is the bubble itself; anything after it is the panel.
        while (container.childCount > 1) container.removeViewAt(1)
        expanded = false
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
                toast(
                    if (poi != null) "${action.label} sent — ${poi.name}"
                    else "${action.label} sent"
                )
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
