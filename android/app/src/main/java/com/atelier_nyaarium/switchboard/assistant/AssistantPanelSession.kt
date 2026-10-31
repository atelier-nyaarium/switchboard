package com.atelier_nyaarium.switchboard.assistant

import android.app.KeyguardManager
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.atelier_nyaarium.switchboard.AppLock
import com.atelier_nyaarium.switchboard.BuildConfig
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.ForegroundHolder
import com.atelier_nyaarium.switchboard.MainActivity
import com.atelier_nyaarium.switchboard.OpenAttachment
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.RowPress
import com.atelier_nyaarium.switchboard.appLockAsks
import com.atelier_nyaarium.switchboard.plugins.Plugins
import com.atelier_nyaarium.switchboard.rememberBoundRendererPool
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.send
import com.atelier_nyaarium.switchboard.setDraftText
import com.atelier_nyaarium.switchboard.stageScreen
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** What the system shared with this showing; memory only, dropped on hide. */
internal data class HeldScreen(val screenshot: Bitmap? = null, val text: String? = null)

/**
 * The panel over another app. Compose needs lifecycle and saved-state owners, wired here by hand,
 * since a session window belongs to no Activity.
 */
internal class AssistantPanelSession(context: Context) :
	VoiceInteractionSession(context),
	LifecycleOwner,
	SavedStateRegistryOwner {
	private val registry = LifecycleRegistry(this)
	private val savedState = SavedStateRegistryController.create(this)
	override val lifecycle: Lifecycle get() = registry
	override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry

	private val repo: ChatRepository = Repo.get(context)
	private val team = MutableStateFlow<String?>(null)
	private val screen = MutableStateFlow(HeldScreen())
	private val attached = MutableStateFlow(false)
	private val sending = MutableStateFlow(false)
	private val shows = MutableStateFlow(0)
	private var leased = false

	// A capture landing after hide belongs to no showing.
	@Volatile private var accepting = false

	override fun onCreate() {
		super.onCreate()
		savedState.performRestore(null)
		registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
		window.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
	}

	override fun onPrepareShow(args: Bundle?, showFlags: Int) {
		super.onPrepareShow(args, showFlags)
		val state = repo.state.value
		val keyguardLocked = context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true
		val asks = appLockAsks(state, AppLock.unlocked.value)
		val landing = panelTeam(state)
		when (val show = panelShow(keyguardLocked, asks, landing)) {
			PanelShow.HandOff -> {
				DebugLog.log("Panel", "hand-off keyguard=$keyguardLocked appLock=$asks team=${landing != null}")
				setUiEnabled(false)
				handOff()
			}
			is PanelShow.Show -> {
				screen.value = HeldScreen()
				attached.value = false
				accepting = true
				setUiEnabled(true)
				team.value = show.team
			}
		}
	}

	/** Today's summon: the app asks for the keyguard and the app lock first. */
	private fun handOff() {
		runIsolated { startAssistantActivity(Intent(Intent.ACTION_ASSIST).setClass(context, MainActivity::class.java)) }
			.onFailure { DebugLog.log("Panel", "hand-off failed: ${it.javaClass.simpleName}") }
		hide()
	}

	override fun onShow(args: Bundle?, showFlags: Int) {
		super.onShow(args, showFlags)
		if (team.value == null) return
		IntegrationProbe.report(context, "panel")
		shows.update { it + 1 }
		repo.phoneHoldOps.onPanelShown()
		registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
		if (!leased) repo.foreground.take(ForegroundHolder.PANEL)
		leased = true
	}

	override fun onHide() {
		accepting = false
		screen.value = HeldScreen()
		attached.value = false
		team.value = null
		if (registry.currentState.isAtLeast(Lifecycle.State.STARTED)) registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
		if (leased) repo.foreground.release(ForegroundHolder.PANEL)
		leased = false
		super.onHide()
		// The next summon gets a fresh session, so a late capture lands nowhere.
		finish()
	}

	override fun onDestroy() {
		if (leased) repo.foreground.release(ForegroundHolder.PANEL)
		leased = false
		registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
		super.onDestroy()
	}

	override fun onBackPressed() = hide()

	override fun onCreateContentView(): View = ComposeView(context).apply {
		setViewTreeLifecycleOwner(this@AssistantPanelSession)
		setViewTreeSavedStateRegistryOwner(this@AssistantPanelSession)
		setContent {
			val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
			val shown by team.collectAsState()
			val held by screen.collectAsState()
			val isAttached by attached.collectAsState()
			val showing by shows.collectAsState()
			val isSending by sending.collectAsState()
			val state by repo.state.collectAsState()
			val unlocked by AppLock.unlocked.collectAsState()
			// The app lock relocked while shown.
			LaunchedEffect(appLockAsks(state, unlocked)) { if (appLockAsks(state, unlocked)) hide() }
			// Its own renderers: the pooled ones belong to MainActivity.
			val pool = rememberBoundRendererPool(
				repo,
				remember { Plugins.get(context) },
				remember { mutableStateOf<OpenAttachment?>(null) },
				remember { mutableStateOf<Pair<String, String>?>(null) },
				remember { mutableStateOf<String?>(null) },
				remember { mutableStateOf<RowPress?>(null) },
			)
			LaunchedEffect(shown != null) { pool.setVisible(shown != null) }
			MaterialTheme(colorScheme = colors) {
				shown?.let { at ->
					AssistantPanel(
						repo = repo,
						pool = pool,
						team = at,
						showing = showing,
						chip = screenChip(held.screenshot != null, !held.text.isNullOrBlank(), isAttached),
						thumbnail = held.screenshot,
						sending = isSending,
						onAttach = { attached.value = it },
						onSend = { send(at) },
						onOpenInApp = ::handOff,
						onClose = ::hide,
					)
				}
			}
		}
	}

	override fun onHandleAssist(state: AssistState) {
		if (!accepting) return
		// A capture that fails to read is dropped, never the process.
		val windows = runIsolated { state.assistStructure?.projected() }.getOrNull().orEmpty()
		screen.update { it.copy(text = screenText(windows).ifBlank { null }) }
		if (BuildConfig.DEBUG) {
			val content = state.assistContent
			val facts = assistFacts(
				windows,
				AssistContentFacts(
					webUri = content?.webUri != null,
					intent = content?.intent != null,
					structuredData = content?.structuredData != null,
					clipData = content?.clipData != null,
					bundleKeys = state.assistData?.keySet()?.size ?: 0,
				),
			)
			DebugLog.log("Probe", probeLine("assist", facts))
		}
	}

	override fun onHandleScreenshot(screenshot: Bitmap?) {
		if (!accepting) return
		screen.update { it.copy(screenshot = screenshot) }
		if (BuildConfig.DEBUG) {
			val facts = linkedMapOf<String, Any>(
				"present" to (screenshot != null),
				"width" to (screenshot?.width ?: 0),
				"height" to (screenshot?.height ?: 0),
			)
			DebugLog.log("Probe", probeLine("screenshot", facts))
		}
	}

	/** What the panel shows: the draft's text and the screen when attached. Its files stay for the app. */
	private fun send(at: String) {
		if (sending.value) return
		val text = repo.state.value.drafts[at]?.text.orEmpty()
		val held = screen.value.takeIf { attached.value } ?: HeldScreen()
		sending.value = true
		repo.command {
			try {
				val png = held.screenshot?.let { shot ->
					ByteArrayOutputStream().also { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
				}
				val staged = stageScreen(png, held.text)
				send(at, text, staged)
				// The row holds its own copy.
				attachments.scheduleAttachmentDelete(staged.mapNotNull { it.src })
			} finally {
				sending.value = false
			}
		}
		repo.setDraftText(at, "")
		attached.value = false
		screen.value = HeldScreen()
	}
}

/** Bounded, so no tree is walked whole or deep enough to run the stack out. */
private const val MAX_NODES = 5_000
private const val MAX_DEPTH = 64

private class NodeBudget(var left: Int = MAX_NODES, var chars: Int = SCREEN_TEXT_MAX_CHARS)

private fun AssistStructure.projected(): List<AssistWindow> {
	val budget = NodeBudget()
	return (0 until windowNodeCount).map { i ->
		val window = getWindowNodeAt(i)
		AssistWindow(titled = !window.title.isNullOrBlank(), root = window.rootViewNode.projected(budget, 0))
	}
}

private fun AssistStructure.ViewNode.projected(budget: NodeBudget, depth: Int): AssistNode {
	budget.left--
	val children = if (depth >= MAX_DEPTH) emptyList() else buildList {
		for (i in 0 until childCount) {
			if (budget.left <= 0) break
			add(getChildAt(i).projected(budget, depth + 1))
		}
	}
	return projectedAs(children, budget)
}

private fun AssistStructure.ViewNode.projectedAs(children: List<AssistNode>, budget: NodeBudget): AssistNode = AssistNode(
	// Copied only up to what is left of the text budget.
	text = text?.let { full ->
		full.subSequence(0, minOf(full.length, budget.chars.coerceAtLeast(0))).toString().also { budget.chars -= it.length }
	},
	textPresent = !text.isNullOrBlank(),
	hint = !hint.isNullOrBlank(),
	contentDescription = !contentDescription.isNullOrBlank(),
	idEntry = idEntry != null,
	className = className != null,
	autofillHints = !autofillHints.isNullOrEmpty(),
	autofillValue = autofillValue != null,
	webDomain = webDomain != null,
	htmlInfo = htmlInfo != null,
	password = isPasswordInput(inputType),
	children = children,
)
