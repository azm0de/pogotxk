package com.pogotxk.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
        startForeground(NOTIFICATION_ID, buildNotification())
        addBubble()
        warmPoiCache()
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

        val circle = TextView(this).apply {
            text = "🔥"
            textSize = 24f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#c8071c"))
                setStroke(dp(2), Color.parseColor("#F2A33C"))
            }
            val size = dp(56)
            layoutParams = FrameLayout.LayoutParams(size, size)
            elevation = dp(6).toFloat()
        }
        container.addView(circle)

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
            x = dp(12)
            y = dp(160)
        }

        circle.setOnTouchListener(dragAndTapListener(layout))

        windowManager.addView(container, layout)
        root = container
        params = layout
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
                    if (!dragging) {
                        view.performClick()
                        toggleExpanded()
                    }
                    true
                }

                else -> false
            }
        }
    }

    private fun toggleExpanded() {
        val container = root ?: return
        if (expanded) {
            collapse()
            return
        }

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setColor(Color.parseColor("#F2c8071c".replace("F2", "EE")))
            }
            // Sits to the right of the bubble.
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply { leftMargin = dp(64); topMargin = dp(4) }
        }

        actions.forEach { action ->
            panel.addView(actionChip(action))
        }
        panel.addView(closeChip())

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

    private fun actionChip(action: Action): TextView = chip(action.emoji) { fire(action) }

    private fun closeChip(): TextView = chip("✕") { collapse() }

    // ------------------------------------------------------------- actions --

    private fun warmPoiCache() {
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { Api.fetchPois() } }
                .onSuccess { pois = it }
        }
    }

    private fun fire(action: Action) {
        if (busy) return
        if (!Api.isSignedIn()) {
            toast("Open PoGo TXK and sign in first")
            collapse()
            return
        }

        busy = true
        collapse()
        toast("Sending ${action.label.lowercase()}…")

        scope.launch {
            try {
                if (pois.isEmpty()) pois = withContext(Dispatchers.IO) { Api.fetchPois() }

                val here = Nearby.currentLocation(this@BubbleService)
                val poi = Nearby.nearest(pois, here, action.poiTypes)

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
