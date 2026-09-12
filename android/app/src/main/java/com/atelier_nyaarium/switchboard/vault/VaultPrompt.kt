package com.atelier_nyaarium.switchboard.vault

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The request itself, drawn over whatever app is in front, the way an authenticator prompt is.
 *
 * PLAIN VIEWS, not Compose, for the reason QueueBubble gives: a Service owns none of the ViewTree
 * owners a ComposeView needs.
 *
 * Unlike the speech bubble, this is not an addition to the shade. A request the owner never sees
 * costs a whole run, so the vault capability is withheld until the overlay can be drawn at all.
 */
class VaultPrompt(
	private val context: Context,
	private val onAnswer: (requestId: String, decision: String, typed: String?) -> Unit,
	private val onOpenSession: (team: String) -> Unit,
) {
	private val windows = context.getSystemService(WindowManager::class.java)
	private var root: LinearLayout? = null
	private var title: TextView? = null
	private var expiry: TextView? = null
	private var who: TextView? = null
	private var command: TextView? = null
	private var password: EditText? = null
	private var actions: LinearLayout? = null

	private var shown: VaultPendingRequest? = null
	private var expanded = false

	// The pending list only re-emits when something settles, so without this the countdown on a
	// security prompt would read whatever it said when the request arrived.
	private val ticker = android.os.Handler(android.os.Looper.getMainLooper())
	private val tick = object : Runnable {
		override fun run() {
			val pending = shown ?: return
			expiry?.text = expiresIn(pending.deadlineAt).text
			ticker.postDelayed(this, 15_000)
		}
	}

	/** Swiped away by hand; the shade still carries it and a tap there brings this back. */
	private val parked = mutableSetOf<String>()

	fun canShow(): Boolean = android.provider.Settings.canDrawOverlays(context)

	/** Re-opened from the notification, so a parked request is wanted again. */
	fun unpark(requestId: String) {
		parked.remove(requestId)
	}

	fun show(pending: VaultPendingRequest, requestTitle: String, requester: String) {
		if (!canShow()) {
			release()
			return
		}
		if (pending.requestId in parked) return
		val view = attached() ?: return
		val changed = shown?.requestId != pending.requestId
		shown = pending
		if (changed) {
			expanded = false
			password?.setText("")
		}
		title?.text = requestTitle
		expiry?.text = expiresIn(pending.deadlineAt).text
		who?.text = requester
		command?.text = pending.operation
		render()
		view.visibility = View.VISIBLE
		ticker.removeCallbacks(tick)
		ticker.postDelayed(tick, 15_000)
	}

	/** Settled or gone: nothing to answer, so nothing is drawn. */
	fun clear(requestId: String) {
		parked.remove(requestId)
		if (shown?.requestId != requestId) return
		shown = null
		expanded = false
		release()
	}

	fun release() {
		ticker.removeCallbacks(tick)
		root?.let { runCatching { windows.removeView(it) } }
		root = null
		title = null
		expiry = null
		who = null
		command = null
		password = null
		actions = null
	}

	private fun render() {
		command?.maxLines = if (expanded) 8 else 1
		password?.visibility = if (expanded) View.VISIBLE else View.GONE
		actions?.visibility = if (expanded) View.VISIBLE else View.GONE
		root?.let { runCatching { windows.updateViewLayout(it, layoutFor(expanded)) } }
	}

	private fun expand() {
		if (expanded) return
		expanded = true
		render()
		password?.requestFocus()
	}

	private fun park() {
		shown?.let { parked.add(it.requestId) }
		release()
	}

	/**
	 * Collapsed the window must not take focus, or the banner steals the keyboard from the app
	 * behind it. Expanded it must, or the password field cannot be typed into.
	 */
	private fun layoutFor(open: Boolean): WindowManager.LayoutParams {
		val flags = if (open) {
			WindowManager.LayoutParams.FLAG_DIM_BEHIND
		} else {
			WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
		}
		return WindowManager.LayoutParams(
			WindowManager.LayoutParams.MATCH_PARENT,
			WindowManager.LayoutParams.WRAP_CONTENT,
			WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
			flags,
			android.graphics.PixelFormat.TRANSLUCENT,
		).apply {
			gravity = if (open) Gravity.CENTER else Gravity.TOP
			if (open) dimAmount = 0.55f
			// A quarter down: high enough to read at a glance, clear of the status bar and the notch.
			y = if (open) 0 else (context.resources.displayMetrics.heightPixels * 0.25f).toInt()
		}
	}

	/** Null when the add failed, keeping nothing, so the next show tries again. */
	private fun attached(): LinearLayout? {
		root?.let { return it }
		val view = build()
		val added = runCatching { windows.addView(view, layoutFor(false)) }.isSuccess
		if (!added) {
			release()
			return null
		}
		root = view
		return view
	}

	private fun build(): LinearLayout {
		val head = LinearLayout(context).apply {
			orientation = LinearLayout.HORIZONTAL
			gravity = Gravity.CENTER_VERTICAL
		}
		val name = text(17f, Color.WHITE).apply {
			setTypeface(android.graphics.Typeface.DEFAULT_BOLD)
		}.also { title = it }
		val left = text(12f, MUTED).also { expiry = it }
		head.addView(name, LinearLayout.LayoutParams(0, WRAP, 1f))
		head.addView(left)

		val requester = text(12.5f, MUTED).also { who = it }
		val op = text(12.5f, Color.WHITE).apply {
			setTypeface(android.graphics.Typeface.MONOSPACE)
			ellipsize = android.text.TextUtils.TruncateAt.END
			setPadding(dp(12), dp(10), dp(12), dp(10))
			background = rounded(FIELD, 10)
		}.also { command = it }

		val secret = EditText(context).apply {
			hint = "Password"
			inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
			textSize = 15f
			setTextColor(Color.WHITE)
			setHintTextColor(MUTED)
			setPadding(dp(13), dp(12), dp(13), dp(12))
			background = outlined(10)
			visibility = View.GONE
		}.also { password = it }

		val row = LinearLayout(context).apply {
			orientation = LinearLayout.HORIZONTAL
			gravity = Gravity.END
			visibility = View.GONE
			addView(flat("Deny") { answer(VAULT_DECISION_DENY) })
			addView(flat("Go to session") { shown?.let { onOpenSession(it.team) }; park() })
			addView(filled("Send") { answer(VAULT_DECISION_ONCE) })
		}.also { actions = it }

		val card = LinearLayout(context).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(dp(18), dp(16), dp(18), dp(16))
			background = rounded(PANEL, 24)
			addView(head)
			addView(requester, spaced(8))
			addView(op, spaced(8))
			addView(secret, spaced(12))
			addView(row, spaced(12))
			setOnTouchListener(
				PromptTouch(onTap = { expand() }, onSwipeAway = { park() }, threshold = dp(56), slop = dp(16)),
			)
		}
		// The window spans the screen; this inset is what keeps the card off both walls, since a
		// window margin is ignored at MATCH_PARENT width.
		return LinearLayout(context).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(dp(14), 0, dp(14), 0)
			addView(card, LinearLayout.LayoutParams(MATCH, WRAP))
		}
	}

	private fun spaced(top: Int) = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(top) }

	private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
		cornerRadius = dp(radius).toFloat()
		setColor(color)
	}

	private fun outlined(radius: Int) = GradientDrawable().apply {
		cornerRadius = dp(radius).toFloat()
		setColor(Color.TRANSPARENT)
		setStroke(dp(1).coerceAtLeast(1), OUTLINE)
	}

	/** Deny and Go to session read as text, so Send is the only thing that looks like the answer. */
	private fun flat(label: String, onClick: () -> Unit) = Button(context).apply {
		text = label
		textSize = 13f
		isAllCaps = false
		setTextColor(PRIMARY)
		background = null
		minWidth = 0
		minimumWidth = 0
		setPadding(dp(12), dp(10), dp(12), dp(10))
		setOnClickListener { onClick() }
	}

	private fun filled(label: String, onClick: () -> Unit) = Button(context).apply {
		text = label
		textSize = 13f
		isAllCaps = false
		setTextColor(ON_PRIMARY)
		background = rounded(PRIMARY, 999)
		minWidth = 0
		minimumWidth = 0
		setPadding(dp(22), dp(10), dp(22), dp(10))
		setOnClickListener { onClick() }
	}

	private fun answer(decision: String) {
		val pending = shown ?: return
		val typed = password?.text?.toString()?.ifBlank { null }
		onAnswer(pending.requestId, decision, if (decision == VAULT_DECISION_DENY) null else typed)
		release()
	}

	private fun text(size: Float, color: Int) = TextView(context).apply {
		textSize = size
		setTextColor(color)
	}

	private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

	/**
	 * A tap opens it, a swipe past `threshold` parks it. A gesture earning neither is neither, the
	 * rule the speech bubble learned: treating "did not swipe" as a tap fires on an ordinary drag.
	 * Expanded, the card's own controls take their taps and this only still hears a swipe.
	 */
	private class PromptTouch(
		private val onTap: () -> Unit,
		private val onSwipeAway: () -> Unit,
		private val threshold: Int,
		private val slop: Int,
	) : View.OnTouchListener {
		private var startX = 0f
		private var travelled = 0f

		override fun onTouch(view: View, event: android.view.MotionEvent): Boolean {
			when (event.actionMasked) {
				android.view.MotionEvent.ACTION_DOWN -> {
					startX = event.rawX
					travelled = 0f
				}
				android.view.MotionEvent.ACTION_MOVE -> {
					val dx = event.rawX - startX
					travelled = maxOf(travelled, kotlin.math.abs(dx))
					view.translationX = dx
				}
				android.view.MotionEvent.ACTION_UP -> {
					val dx = event.rawX - startX
					view.translationX = 0f
					when {
						kotlin.math.abs(dx) > threshold -> onSwipeAway()
						travelled <= slop -> onTap()
					}
				}
				android.view.MotionEvent.ACTION_CANCEL -> view.translationX = 0f
				else -> return false
			}
			return true
		}
	}

	private companion object {
		const val WRAP = android.view.ViewGroup.LayoutParams.WRAP_CONTENT
		const val MATCH = android.view.ViewGroup.LayoutParams.MATCH_PARENT
		val MUTED: Int = Color.parseColor("#B9B2C4")
		val PANEL: Int = Color.parseColor("#241F2D")
		val FIELD: Int = Color.parseColor("#191622")
		val OUTLINE: Int = Color.parseColor("#4A4550")
		val PRIMARY: Int = Color.parseColor("#D0BCFF")
		val ON_PRIMARY: Int = Color.parseColor("#33184E")
	}
}
