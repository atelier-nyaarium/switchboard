package com.atelier_nyaarium.switchboard.vault

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.SwitchboardTheme
import com.atelier_nyaarium.switchboard.runIsolated
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The request itself, drawn over whatever app is in front, the way an authenticator prompt is. It
 * draws [VaultRequestCard], the app's own sheet, so the two cannot drift.
 *
 * Unlike the speech bubble, this is not an addition to the shade. A request the owner never sees
 * costs a whole run, so the vault capability is withheld until the overlay can be drawn at all.
 */
class VaultPrompt(
	private val context: Context,
	private val repo: ChatRepository,
	private val onOpenSession: (team: String) -> Unit,
	/** The request this is currently drawing, so the conversation knows not to tile it twice. */
	private val visible: MutableStateFlow<String?>,
) : LifecycleOwner, SavedStateRegistryOwner {
	private val windows = context.getSystemService(WindowManager::class.java)
	private val registry = LifecycleRegistry(this)
	private val savedState = SavedStateRegistryController.create(this)
	override val lifecycle: Lifecycle get() = registry
	override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry

	private var root: ComposeView? = null
	private val drawn = MutableStateFlow<String?>(null)
	private val expanded = MutableStateFlow(false)

	/** Out of the way while the presence prompt shows over the app in front. */
	private var stepped = false

	/** Swiped away by hand; the shade still carries it and a tap there brings this back. */
	private val parked = mutableSetOf<String>()

	init {
		savedState.performRestore(null)
		registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
	}

	fun canShow(): Boolean = OverlayPermission.granted(context)

	/** Re-opened from the notification, so a parked request is wanted again. */
	fun unpark(requestId: String) {
		parked.remove(requestId)
	}

	fun show(requestId: String) {
		if (!canShow()) {
			release()
			return
		}
		if (requestId in parked) return
		val view = attached() ?: return
		if (drawn.value != requestId) expanded.value = false
		drawn.value = requestId
		place()
		view.visibility = View.VISIBLE
		visible.value = requestId
	}

	/** Settled or gone: nothing to answer, so nothing is drawn. */
	fun clear(requestId: String) {
		parked.remove(requestId)
		if (drawn.value != requestId) return
		release()
	}

	fun release() {
		visible.value = null
		drawn.value = null
		expanded.value = false
		stepped = false
		root?.let { runIsolated { windows.removeView(it) } }
		root = null
	}

	private fun place() {
		root?.let { runIsolated { windows.updateViewLayout(it, layout()) } }
	}

	private fun expand() {
		if (expanded.value) return
		expanded.value = true
		place()
	}

	private fun park() {
		drawn.value?.let { parked.add(it) }
		release()
	}

	/** Asks only when the gate would; the card steps aside so the prompt is not drawn under it. */
	private suspend fun confirmPresence(): Boolean {
		if (repo.vaultOps.ownerPresent(null)) return true
		step(aside = true)
		try {
			return PresencePrompt.ask(context)
		} finally {
			step(aside = false)
		}
	}

	private fun step(aside: Boolean) {
		stepped = aside
		root?.visibility = if (aside) View.INVISIBLE else View.VISIBLE
		place()
	}

	/**
	 * Collapsed the window must not take focus, or the banner steals the keyboard from the app
	 * behind it. Expanded it must, or the password field cannot be typed into.
	 */
	private fun layout(): WindowManager.LayoutParams {
		val open = expanded.value
		val flags = when {
			stepped -> WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
			open -> WindowManager.LayoutParams.FLAG_DIM_BEHIND
			// NOT_TOUCH_MODAL lets taps pass, so the dim reads as held without the card taking the screen.
			else -> WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
				WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
				WindowManager.LayoutParams.FLAG_DIM_BEHIND
		}
		return WindowManager.LayoutParams(
			WindowManager.LayoutParams.MATCH_PARENT,
			WindowManager.LayoutParams.WRAP_CONTENT,
			WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
			flags,
			android.graphics.PixelFormat.TRANSLUCENT,
		).apply {
			gravity = if (open) Gravity.CENTER else Gravity.TOP
			dimAmount = if (stepped) 0f else if (open) 0.55f else 0.3f
			y = if (open) 0 else (context.resources.displayMetrics.heightPixels * 0.15f).toInt()
		}
	}

	/** Null when the add failed, keeping nothing, so the next show tries again. */
	private fun attached(): ComposeView? {
		root?.let { return it }
		val view = ComposeView(context).apply {
			setViewTreeLifecycleOwner(this@VaultPrompt)
			setViewTreeSavedStateRegistryOwner(this@VaultPrompt)
			setContent { Prompt() }
		}
		if (runIsolated { windows.addView(view, layout()) }.isFailure) {
			release()
			return null
		}
		root = view
		return view
	}

	@Composable
	private fun Prompt() {
		SwitchboardTheme {
			val id by drawn.collectAsState()
			val open by expanded.collectAsState()
			val pending by repo.vault.pending.collectAsState()
			val state by repo.state.collectAsState()
			val request = pending.firstOrNull { it.requestId == id } ?: return@SwitchboardTheme
			val exits = remember(request.requestId) {
				VaultPromptExits(
					goToSession = {
						onOpenSession(request.team)
						park()
					},
					confirmPresence = ::confirmPresence,
				)
			}
			// A swipe past this parks it; a tap opens it.
			val threshold = with(LocalDensity.current) { 56.dp.toPx() }
			var dx by remember(request.requestId) { mutableFloatStateOf(0f) }
			val gestures = Modifier
				.offset { IntOffset(dx.roundToInt(), 0) }
				.pointerInput(request.requestId) {
					detectHorizontalDragGestures(
						onDragEnd = {
							if (abs(dx) > threshold) park()
							dx = 0f
						},
						onDragCancel = { dx = 0f },
					) { change, amount ->
						change.consume()
						dx += amount
					}
				}
			val interactions = remember { MutableInteractionSource() }
			val tap = if (open) Modifier else Modifier.clickable(interactions, null) { expand() }
			Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
				VaultRequestCard(
					repo = repo,
					state = state,
					request = request,
					onClose = { clear(request.requestId) },
					modifier = gestures.then(tap),
					collapsed = !open,
					exits = exits,
				)
			}
		}
	}
}
