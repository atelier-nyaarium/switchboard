package com.atelier_nyaarium.switchboard

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.board.BoardEntryDialog
import com.atelier_nyaarium.switchboard.board.GroupKey
import com.atelier_nyaarium.switchboard.plugins.Plugins
import kotlinx.coroutines.launch

/** Process-lifetime repository. */
object Repo {
	@Volatile private var instance: ChatRepository? = null

	fun get(context: Context): ChatRepository {
		val repo = instance ?: synchronized(this) {
			val app = context.applicationContext
			instance ?: ChatRepository(
				store = AppStateStore(app),
				filesDir = app.filesDir,
				contentResolver = app.contentResolver,
				applicationContext = app,
				sttsCatalog = loadSttsCatalog(app),
			).also { instance = it }
		}
		repo.phoneCapabilityOps.start()
		return repo
	}

	/** Malformed catalog means empty. */
	private fun loadSttsCatalog(app: Context): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> =
		runIsolated {
			val json = app.assets.open("stts-providers.json").bufferedReader().use { it.readText() }
			kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
				.decodeFromString<com.atelier_nyaarium.switchboard.proto.SttsProviders>(json)
				.providers
		}.getOrDefault(emptyList())
}

// Biometric prompt requires FragmentActivity.
class MainActivity : FragmentActivity() {
	private val openTeamRequest = mutableStateOf<String?>(null)

	private val openQueueRequest = mutableStateOf(false)

	private val vaultRequestRequest = mutableStateOf<String?>(null)

	private val assistantSendRequestRequest = mutableStateOf<Pair<String, String>?>(null)
	private val assistantActRequestRequest = mutableStateOf<Pair<String, String>?>(null)

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		DebugLog.init(this)
		if (savedInstanceState == null) com.atelier_nyaarium.switchboard.assistant.IntegrationProbe.report(this, "start")
		val repo = Repo.get(this)
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runIsolated { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		consume(intent, restored = savedInstanceState != null)
		setContent {
			SwitchboardTheme {
				App(repo, injected, openTeamRequest, openQueueRequest, vaultRequestRequest, assistantSendRequestRequest, assistantActRequestRequest)
			}
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent)
		consume(intent, restored = false)
	}

	override fun onResume() {
		super.onResume()
		retryDismissal()
		// Recheck after Settings.
		Repo.get(this).phoneRadio.resumed()
	}

	override fun onDestroy() {
		// A rotation keeps the unlock.
		if (isFinishing) AppLock.relock()
		super.onDestroy()
	}

	private fun keyguard(): KeyguardManager? = getSystemService(KeyguardManager::class.java)

	private fun retryDismissal() {
		val keyguard = keyguard()
		SummonBus.retried(keyguard?.isKeyguardLocked == true, keyguard?.isDeviceLocked == true)?.let { dismissKeyguard(it.id) }
	}

	private fun dismissKeyguard(id: Long) {
		val callback = object : KeyguardManager.KeyguardDismissCallback() {
			override fun onDismissSucceeded() = SummonBus.step(id, Summon::dismissed)

			override fun onDismissCancelled() = SummonBus.step(id, Summon::cancelled)

			override fun onDismissError() = dismissFailed(id)
		}
		runIsolated { keyguard()?.requestDismissKeyguard(this, callback) }.onFailure { dismissFailed(id) }
	}

	private fun dismissFailed(id: Long) {
		SummonBus.step(id, Summon::failed)
		// Already resumed: no later resume retries it.
		if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) retryDismissal()
	}

	/** Remove one-shot extras after consumption. */
	private fun consume(intent: Intent, restored: Boolean) {
		val opensElsewhere = OPEN_EXTRAS.any(intent::hasExtra)
		if (opensElsewhere) SummonBus.supersede()
		if (intent.action == Intent.ACTION_ASSIST) {
			if (isFreshSummon(intent.action, restored, intent.flags)) {
				val keyguard = keyguard()
				val summon = SummonBus.raise(keyguard?.isKeyguardLocked == true, keyguard?.isDeviceLocked == true)
				if (requestsDismissal(summon)) dismissKeyguard(summon.id)
			}
			intent.action = null
		}
		intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM)?.let {
			openTeamRequest.value = it
			intent.removeExtra(SwitchboardService.EXTRA_OPEN_TEAM)
		}
		if (intent.getBooleanExtra(SwitchboardService.EXTRA_OPEN_QUEUE, false)) {
			openQueueRequest.value = true
			intent.removeExtra(SwitchboardService.EXTRA_OPEN_QUEUE)
		}
		intent.getStringExtra(SwitchboardService.EXTRA_VAULT_REQUEST)?.let {
			vaultRequestRequest.value = it
			intent.removeExtra(SwitchboardService.EXTRA_VAULT_REQUEST)
		}
		val requestId = intent.getStringExtra(SwitchboardService.EXTRA_ASSISTANT_SEND_REQUEST)
		val gatewayId = intent.getStringExtra(SwitchboardService.EXTRA_ASSISTANT_SEND_GATEWAY)
		if (requestId != null && gatewayId != null) assistantSendRequestRequest.value = gatewayId to requestId
		intent.removeExtra(SwitchboardService.EXTRA_ASSISTANT_SEND_REQUEST)
		intent.removeExtra(SwitchboardService.EXTRA_ASSISTANT_SEND_GATEWAY)
		val actRequestId = intent.getStringExtra(SwitchboardService.EXTRA_ASSISTANT_ACT_REQUEST)
		val actGatewayId = intent.getStringExtra(SwitchboardService.EXTRA_ASSISTANT_ACT_GATEWAY)
		if (actRequestId != null && actGatewayId != null) assistantActRequestRequest.value = actGatewayId to actRequestId
		intent.removeExtra(SwitchboardService.EXTRA_ASSISTANT_ACT_REQUEST)
		intent.removeExtra(SwitchboardService.EXTRA_ASSISTANT_ACT_GATEWAY)
	}
}

/** Extras that open views. */
private val OPEN_EXTRAS = listOf(
	SwitchboardService.EXTRA_OPEN_TEAM,
	SwitchboardService.EXTRA_OPEN_QUEUE,
	SwitchboardService.EXTRA_VAULT_REQUEST,
	SwitchboardService.EXTRA_ASSISTANT_SEND_REQUEST,
	SwitchboardService.EXTRA_ASSISTANT_ACT_REQUEST,
)

/** The vault's open modal. */
private sealed interface VaultModal {
	data class Entry(val id: String?) : VaultModal

	data class Request(val id: String) : VaultModal
}

/** Runbook fire and destination. */
private data class RunbookFire(val gatewayId: String, val id: String, val into: String?)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun App(
	repo: ChatRepository,
	injectedBlob: String?,
	openTeamRequest: MutableState<String?>,
	openQueueRequest: MutableState<Boolean>,
	vaultRequestRequest: MutableState<String?> = remember { mutableStateOf(null) },
	assistantSendRequestRequest: MutableState<Pair<String, String>?> = remember { mutableStateOf(null) },
	assistantActRequestRequest: MutableState<Pair<String, String>?> = remember { mutableStateOf(null) },
) {
	val state by repo.state.collectAsState()
	val bootState by repo.bootState.collectAsState()
	val missingBoot = bootState as? BootState.Missing
	val context = LocalContext.current
	val activity = context.fragmentActivity()
	var nav by rememberSaveable(stateSaver = ShellNavSaver) { mutableStateOf(ShellNav()) }
	val openTeam = nav.conversation?.team
	// Composition mirror; store persists.
	var boardStripHeight by remember { mutableStateOf(repo.store.boardStripHeight) }
	var boardModal by remember { mutableStateOf<String?>(null) }
	var vaultModal by remember { mutableStateOf<VaultModal?>(null) }
	var assistantSendModal by remember { mutableStateOf<Pair<String, String>?>(null) }
	var assistantActModal by remember { mutableStateOf<Pair<String, String>?>(null) }
	var fireRunbook by remember { mutableStateOf<RunbookFire?>(null) }
	// Gateway and id. Null is closed, a blank id is a new one.
	var editRunbook by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
	var editRoutine by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
	var editPolicy by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
	var drawerSide by remember { mutableStateOf(repo.store.drawerSide) }
	val shellScope = rememberCoroutineScope()
	val menuDrawer = remember { SideDrawers() }
	val shellActions = ShellActions(
		openBoardEntry = { boardModal = it },
		moveBoardEntry = { row, drop -> repo.boardOps.boardMove(row.entry.id, drop.parent, drop.index) },
		openVaultEntry = { vaultModal = VaultModal.Entry(it) },
		openVaultRequest = { vaultModal = VaultModal.Request(it) },
		fireRunbook = { gatewayId, id, into -> fireRunbook = RunbookFire(gatewayId, id, into) },
		editRunbook = { gatewayId, id -> editRunbook = gatewayId to id.orEmpty() },
		editRoutine = { gatewayId, id -> editRoutine = gatewayId to id.orEmpty() },
		editPolicy = { gatewayId, id -> editPolicy = gatewayId to id.orEmpty() },
	)
	// Clear reveal after handoff.
	val revealAtState = remember { mutableStateOf<Pair<String, Long>?>(null) }
	var revealAt by revealAtState
	// Queue state keys on revision.
	val queueRevision by repo.playback.queueRevision.collectAsState()
	val queueState = remember(queueRevision) {
		val (active, paused) = repo.playback.transportState()
		when {
				// Alerts outrank playback.
			repo.playback.failedRows().isNotEmpty() -> QueueGlance.ALERT
			active && paused -> QueueGlance.PAUSED
			active -> QueueGlance.SPEAKING
			else -> QueueGlance.IDLE
		}
	}
	// Overlays are not saveable; they may contain key material.
	var overlays by remember { mutableStateOf(emptyList<Overlay>()) }
	val openOverlay = { overlay: Overlay -> overlays = overlays.pushOverlay(overlay) }
	val closeOverlay = { overlays = overlays.popOverlay() }
	// Offer ceremony once.
	var enrolleeCeremonyOffered by remember { mutableStateOf(false) }
	val unlocked by AppLock.unlocked.collectAsState()

	// Initialize plugins before registry reads.
	val pluginManager = remember { Plugins.get(context) }
	val forgetSession = remember { SessionForget(context, repo, pluginManager.host.threadForgetHandlers) }
	var forgetAsking by remember { mutableStateOf<ForgetAsking?>(null) }
	// Leave once the forget commits.
	SideEffect { forgetSession.onForgotten = { forgotten -> nav = nav.forgot(forgotten) } }
	val requestForget = { team: String, cancelTasks: Boolean? ->
		when (val ask = forgetSession.ask(team)) {
			ForgetAsk.None -> forgetSession.forget(team, cancelTasks)
			else -> forgetAsking = ForgetAsking(team, cancelTasks, ask)
		}
	}
	// Nothing draws over the lock.
	if (!appLockAsks(state, unlocked)) forgetAsking?.let { asking ->
		ForgetAskDialog(
			ask = asking.ask,
			onStart = { container ->
				forgetSession.startThenForget(asking.team, container, asking.cancelTasks)
				forgetAsking = null
			},
			onForgetAnyway = {
				forgetSession.forget(asking.team, asking.cancelTasks)
				forgetAsking = null
			},
			onDismiss = { forgetAsking = null },
		)
	}

	val viewerState = remember { mutableStateOf<OpenAttachment?>(null) }
	var viewer by viewerState
	val linkMenuState = remember { mutableStateOf<Pair<String, String>?>(null) }
	val linkMenuNoteState = remember { mutableStateOf<String?>(null) }
	val rowPressState = remember { mutableStateOf<RowPress?>(null) }
	val rendererPool = rememberBoundRendererPool(repo, pluginManager, viewerState, linkMenuState, linkMenuNoteState, rowPressState)

	LaunchedEffect(injectedBlob) {
		if (injectedBlob != null && Need.PROVISIONING in (missingBoot?.needs ?: emptySet())) {
			repo.provision(injectedBlob)
		}
	}
	// Offer pending ceremony once.
	LaunchedEffect(state.provisioned, state.firstRooted) {
		if (state.provisioned && !enrolleeCeremonyOffered) {
			repo.ceremony.pendingEnrolleeCeremony()?.let {
				openOverlay(Overlay.EnrolleeCeremony(it))
				enrolleeCeremonyOffered = true
			}
		}
	}
	// Service owns connection and polling.
	val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
	LaunchedEffect(state.provisioned) {
		if (state.provisioned) {
			SwitchboardService.start(context)
			if (
				context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
				android.content.pm.PackageManager.PERMISSION_GRANTED
			) {
				notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
			}
		}
	}
	// Foreground triggers poll and reconciliation.
	androidx.lifecycle.compose.LifecycleStartEffect(Unit) {
		repo.foreground.take(ForegroundHolder.ACTIVITY)
		rendererPool.setVisible(true)
		repo.command { reconcilePending() }
		onStopOrDispose {
			repo.foreground.release(ForegroundHolder.ACTIVITY)
			rendererPool.setVisible(false)
		}
	}
	val features = DrawerFeatures(board = pluginManager.isActive("taskboard"), vault = pluginManager.isActive("vault"))
	val offeredRoot = rootViews(features)
	val offeredFor = { team: String -> conversationViews(terminalEligible(state, team), isAssistant(state, team)) }
	val offeredConversation = openTeam?.let(offeredFor).orEmpty()
	val assistantOpen = openTeam?.let { isAssistant(state, it) } == true
	val assistantRoot = assistantRoot(state)
	val assistantPages = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
	val factsFor = { team: String ->
		ArrivalFacts(
			offered = offeredFor(team),
			stuckAtLogin = stuckAtLogin(state.sessions().firstOrNull { it.name == team }?.presence),
		)
	}
	// Every road that lands somewhere takes this one list.
	val dismissForArrival = {
		if (menuDrawer.holdsBack()) shellScope.launch { menuDrawer.close() }
		nav = nav.closeSettings()
		overlays = emptyList()
		editRunbook = null
		editRoutine = null
		editPolicy = null
		fireRunbook = null
		boardModal = null
		vaultModal = null
		viewer = null
		openQueueRequest.value = false
		linkMenuState.value = null
		linkMenuNoteState.value = null
		rowPressState.value = null
		assistantSendModal = null
		assistantActModal = null
	}
	// The one arrival road.
	val arriveAt = { team: String, arrival: Arrival, place: WorkspacePlace? ->
		val assistant = isAssistant(state, team)
		val key = if (assistant) repo.fromCanonical(team) else repo.openThread(team)
		if (key != null) {
			dismissForArrival()
			nav = nav.arriveAt(key, assistant, arrival, factsFor(key), place)
		}
		key
	}
	val summon by SummonBus.pending.collectAsState()
	val windowFocused = androidx.compose.ui.platform.LocalWindowInfo.current.isWindowFocused
	val lifecycleState by androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
	val resumed = lifecycleState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
	LaunchedEffect(summon?.id, summon?.routed, missingBoot == null, resumed) {
		val held = summon ?: return@LaunchedEffect
		if (!routesNow(held, booted = missingBoot == null, resumed = resumed)) return@LaunchedEffect
		val landing = summonLanding(state, assistantRoot, assistantGateway(state)).let { landing ->
			val at = (landing as? SummonLanding.At)?.team ?: return@let landing
			repo.fromCanonical(at)?.let { SummonLanding.At(it) } ?: SummonLanding.Root
		}
		dismissForArrival()
		nav = nav.summonedTo(landing, factsFor)
		if (landing == SummonLanding.Configure) SummonBus.step(held.id, Summon::focusSpent)
		SummonBus.step(held.id, Summon::routedNow)
	}
	LaunchedEffect(assistantRoot, nav.root, nav.conversation == null, nav.settings) {
		nav = nav.enterAssistant(assistantRoot, factsFor)
	}
	val deviceViews by repo.deviceOps.views.collectAsState()
	LaunchedEffect(assistantRoot, openTeam, nav.root, nav.assistantPage, state.gateways, deviceViews, offeredRoot) {
		nav = nav.followAssistant(assistantRoot, state).resolvePage(state) { deviceViews[it]?.list }.offering(offeredRoot)
	}
	// A ref's exit opens Files. Clearing first prevents duplicate routing.
	val workspaceRequest by com.atelier_nyaarium.switchboard.workspace.WorkspaceOpenBus.pending.collectAsState()
	LaunchedEffect(workspaceRequest, state.teams, state.gateways.loaded, resumed) {
		// The shown window takes it, never one beneath a picker.
		val request = workspaceRequest?.takeIf { resumed } ?: return@LaunchedEffect
		val standing = standingOf(state.teams, state.gateways.loaded, request.team)
		if (standing == RequestStanding.Wait) return@LaunchedEffect
		com.atelier_nyaarium.switchboard.workspace.WorkspaceOpenBus.shown(request)
		// The assistant has no Files.
		if (isAssistant(state, request.team)) {
			arriveAt(request.team, Arrival.FILES_ASKED, null)
			return@LaunchedEffect
		}
		val row = state.teams.firstOrNull { it.name == request.team }
		if (row == null || standing != RequestStanding.Show) return@LaunchedEffect
		val place = when (val open = request.open) {
			is com.atelier_nyaarium.switchboard.workspace.WorkspaceOpen.File -> WorkspacePlace.Outline(open.path)
			is com.atelier_nyaarium.switchboard.workspace.WorkspaceOpen.Window -> {
				// This effect ends when the bus clears, so use the shell scope.
				shellScope.launch { repo.windowOps.openWindow(targetOf(row), open.symbolId) }
				WorkspacePlace.Windows
			}
		}
		arriveAt(request.team, Arrival.FILES_ASKED, place)
	}
	LaunchedEffect(openTeamRequest.value) {
		openTeamRequest.value?.let { team ->
			arriveAt(team, Arrival.OUTSIDE, null) ?: return@let
			openTeamRequest.value = null
		}
	}

	// A notification tap opens the request. It opens over drafts, so only settings and overlays close.
	LaunchedEffect(vaultRequestRequest.value) {
		vaultRequestRequest.value?.let { requestId ->
			nav = nav.closeSettings()
			overlays = emptyList()
			vaultModal = VaultModal.Request(requestId)
			vaultRequestRequest.value = null
		}
	}

	LaunchedEffect(assistantSendRequestRequest.value) {
		assistantSendRequestRequest.value?.let { request ->
			dismissForArrival()
			assistantSendModal = request
			assistantSendRequestRequest.value = null
		}
	}

	LaunchedEffect(assistantActRequestRequest.value) {
		assistantActRequestRequest.value?.let { request ->
			dismissForArrival()
			assistantActModal = request
			assistantActRequestRequest.value = null
		}
	}

	LaunchedEffect(openTeam) {
		if (openTeam == null) repo.kickPoll()
	}

	val locked = appLockAsks(state, unlocked)
	LaunchedEffect(summon, resumed) {
		val held = summon ?: return@LaunchedEffect
		if (!resumed || !satisfiesAppLock(held)) return@LaunchedEffect
		AppLock.unlock()
		SummonBus.step(held.id, Summon::lockTakenNow)
	}
	var lockPrompted by remember(locked) { mutableStateOf(false) }
	LaunchedEffect(locked, windowFocused, summon) {
		if (activity == null || !promptsAppLock(locked, windowFocused, lockPrompted, summon)) return@LaunchedEffect
		lockPrompted = true
		promptUnlock(activity) { ok -> if (ok) AppLock.unlock() }
	}

	val screen = shellScreen(nav, locked, overlays.isNotEmpty(), missingBoot == null)
	val assistantShown = nav.showsAssistant(assistantOpen, screen)
	LaunchedEffect(assistantShown) {
		if (assistantShown) repo.phoneHoldOps.onAssistantShown()
	}
	val homeRead = nav.readsHome(assistantOpen, screen, offeredRoot)
	val sourcesMoved by repo.assistantOps.sourcesMoved.collectAsState()
	val homeReader = if (homeRead) screen to nav.rootShown(offeredRoot) else null
	LaunchedEffect(homeVersions(state), state.gateways.incarnations(), state.gateways.reachableIds(), state.router.settled, homeReader, sourcesMoved) {
		if (homeReader == null) return@LaunchedEffect
		// Covers a screen before the first drain.
		repo.assistantOps.refreshShown()
	}
	// A drawer left open never reappears open. On the shell's scope: a return cancels this effect.
	LaunchedEffect(screen in MENU_SCREENS) {
		if (screen !in MENU_SCREENS && menuDrawer.holdsBack()) shellScope.launch { menuDrawer.snapClosed() }
	}
	// The lock hides the editors; one whose edit ended or was dropped meanwhile does not return.
	LaunchedEffect(locked) {
		if (!locked) return@LaunchedEffect
		launch { repo.runbookOps.edits.held.collect { held -> editRunbook = editRunbook?.takeIf { hiddenEditor(editKeyOf(it), held.keys) != null } } }
		launch { repo.routineOps.edits.held.collect { held -> editRoutine = editRoutine?.takeIf { hiddenEditor(editKeyOf(it), held.keys) != null } } }
		launch { repo.policyOps.edits.held.collect { held -> editPolicy = editPolicy?.takeIf { hiddenEditor(editKeyOf(it), held.keys) != null } } }
		repo.automationOps.edits.held.collect { held ->
			val page = nav.assistantPage as? AssistantPage.AutomationEditor ?: return@collect
			if (hiddenEditor(AutomationDraftKey(page.gatewayId, page.slot), held.keys) == null) nav = nav.closeAssistantPage()
		}
	}
	// No drawer over the summoned composer.
	LaunchedEffect(summon?.id, summon?.routed) {
		if (summon?.routed == true && menuDrawer.holdsBack()) menuDrawer.close()
	}
	val vaultPending by repo.vault.pending.collectAsState()
	val menuBadges = offeredRoot.map { rootBadge(it, if (features.vault) vaultPending.size else 0) }
	val openMenu: () -> Unit = { shellScope.launch { menuDrawer.open(drawerSide) } }
	// Every close runs on the shell's scope: a pick can swap the screen under the drawer.
	val menuSheet: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit = {
		MenuSheet(
			views = offeredRoot,
			shown = nav.menuShown(offeredRoot, assistantOpen),
			badges = menuBadges,
			domainId = state.domainId,
			onPick = { view ->
				nav = nav.pick(view, assistantOpen)
				shellScope.launch { menuDrawer.close() }
			},
			onSettings = {
				shellScope.launch { menuDrawer.close() }
				nav = nav.openSettings()
			},
		)
	}
	val shownConversationView = nav.conversation?.let { shownView(offeredConversation, it.view) }
	val composerShown = openTeam != null && state.scheduledSends[openTeam] == null
	val shownToSummon = summonShown(
		screen,
		nav,
		assistantOpen,
		shownConversationView,
		assistantRoot,
		composerShown,
		covered = menuDrawer.holdsBack(),
	)
	val focus = focusStep(summon, shownToSummon, windowFocused, resumed)
	LaunchedEffect(focus, summon?.id) {
		if (focus == FocusStep.DROP) summon?.let { SummonBus.step(it.id, Summon::focusSpent) }
	}
	// The one Back authority: `backLayer` orders what is drawn over what.
	val backFacts = BackFacts(
		editorOpen = editRunbook != null || editRoutine != null || editPolicy != null,
		locked = locked,
		overlayOpen = overlays.isNotEmpty(),
		booted = missingBoot == null,
		drawerOpen = menuDrawer.holdsBack(),
		offeredRoot = offeredRoot,
		offeredConversation = offeredConversation,
		assistantOpen = assistantOpen,
	)
	val layer = backLayer(nav, backFacts)
	// A changed automation draft asks first.
	val leaveAssistantPage = {
		val editor = nav.assistantPage as? AssistantPage.AutomationEditor
		if (editor == null || repo.automationOps.edits.askLeave(AutomationDraftKey(editor.gatewayId, editor.slot))) {
			nav = nav.back(BackLayer.ASSISTANT_PAGE, backFacts, state.provisioned)
		}
	}
	BackHandler(enabled = layer != null) {
		when (layer) {
			BackLayer.ASSISTANT_PAGE -> leaveAssistantPage()
			// A changed draft asks first.
			BackLayer.EDITOR -> when {
				editPolicy != null -> if (repo.policyOps.edits.askLeave(editKeyOf(editPolicy))) editPolicy = null
				editRoutine != null -> if (repo.routineOps.edits.askLeave(editKeyOf(editRoutine))) editRoutine = null
				else -> if (repo.runbookOps.edits.askLeave(editKeyOf(editRunbook))) editRunbook = null
			}
			BackLayer.OVERLAY -> closeOverlay()
			BackLayer.DRAWER -> shellScope.launch { menuDrawer.close() }
			null -> Unit
			else -> nav = nav.back(layer, backFacts, state.provisioned)
		}
	}

	when (screen) {
		ShellScreen.LOCK -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) AppLock.unlock() } } })
		ShellScreen.OVERLAY -> OverlayHost(overlays.last(), repo, state, openOverlay, closeOverlay)
		// Settings remains reachable before provisioning.
		ShellScreen.SETTINGS ->
			SettingsScreen(
				state = state,
				repo = repo,
				plugins = pluginManager,
				route = nav.settings ?: SettingsRoute.HUB,
				onRoute = { nav = nav.openSettings(it) },
				onSetDeviceName = { repo.command { setDeviceName(it) } },
				onToggleBiometric = { repo.setBiometricLock(it) },
				onManage = { openOverlay(Overlay.Manage) },
				onYourDevices = { openOverlay(Overlay.YourDevices) },
				onFederation = { openOverlay(Overlay.Users) },
				// Close Settings first.
				onAssistant = { nav = nav.closeSettings().openAssistantPage(AssistantPage.Settings) },
				onClear = {
					// Wipe plugins and notifications after local wipe.
					pluginManager.host.accountWipeHandlers.forEachCaught(onError = ::logPluginThrow) { it.onWipe(context) }
					ServiceNotifications.cancelProvisioningNotifications(context)
					dismissForArrival()
					nav = ShellNav()
				},
				onCloseSettings = { nav = nav.closeSettings() },
				drawerSide = drawerSide,
				onDrawerSide = {
					drawerSide = it
					repo.store.drawerSide = it
				},
			)
		ShellScreen.BOOT -> when {
			Need.PROVISIONING in missingBoot?.needs.orEmpty() ->
				ProvisionScreen(
					repo = repo,
					state = state,
					onProvision = { repo.command { provision(it) } },
					onSettings = { nav = nav.openSettings() },
					onFederation = { nav = nav.openSettings(SettingsRoute.FEDERATION) },
				)
			else -> DomainConnectingScreen(onSettings = { nav = nav.openSettings() })
		}
		ShellScreen.ASSISTANT_PAGE -> nav.assistantPage?.let { page ->
			assistantPages.SaveableStateProvider(pageKey(page)) {
				com.atelier_nyaarium.switchboard.assistant.AssistantPageHost(
					repo = repo,
					state = state,
					page = page,
					home = assistantGateway(state),
					onListDirs = { path, hostTarget, spawn -> repo.sessions.listDirs(path, hostTarget, spawn) },
					onPage = { nav = nav.openAssistantPage(it) },
					onRoot = { nav = nav.toRoot(it, assistantOpen) },
					onClose = { nav = nav.closeAssistantPage() },
					onBack = leaveAssistantPage,
				)
			}
		}
		ShellScreen.CONVERSATION -> {
			// Devcontainer names are fixed.
			val session = state.sessions().firstOrNull { it.name == openTeam }
			val sessionCli = harnessOf(session)
			val kind = session?.kind
			// Rename only known loose sessions.
			val presence = session?.let { state.sessionWord(it.name, it.presence, System.currentTimeMillis()) }
			val boardOn = pluginManager.isActive("taskboard")
			val boardTeam = state.teams.firstOrNull { it.name == openTeam }
			val boardKey = boardTeam?.let { GroupKey(it.domainId, it.gatewayId, repo.boardOps.boardSessionKeyOf(openTeam!!)) }
			LaunchedEffect(openTeam, boardOn, boardKey) {
				if (boardOn) repo.boardOps.refreshBoard()
			}
			val boardRevision by repo.boardOps.boardRevision
				// Failed reads do not advance revision.
			val boardStripFor = remember(openTeam, boardRevision, boardOn, boardKey) {
				if (boardOn) repo.boardOps.boardGroupFor(openTeam!!) else null
			}
			val boardLiveLineFor = remember(openTeam, boardRevision, boardOn, boardKey) {
				if (boardOn) repo.boardOps.boardLiveLineFor(openTeam!!) else null
			}
			// The overlay draws over this screen, so a request it is already showing is not tiled
			// again underneath it.
			val promptShowing by repo.vault.promptShowing.collectAsState()
			val vaultRevision by repo.vault.revision
			val vaultTileFor = remember(openTeam, vaultPending, promptShowing, vaultRevision) {
				vaultPending
					.firstOrNull { it.team == openTeam && it.requestId != promptShowing }
					?.let { request ->
						com.atelier_nyaarium.switchboard.vault.VaultTile(
							requestId = request.requestId,
							title = com.atelier_nyaarium.switchboard.vault.requestTitle(
								request,
								request.entryId?.let { repo.vaultOps.view(it)?.title },
							),
							requester = com.atelier_nyaarium.switchboard.vault.requester(state, request),
							operation = request.operation,
							deadlineAt = request.deadlineAt,
						)
					}
			}
			val team = openTeam!!
			val offered = offeredConversation
			val shown = shownView(offered, nav.conversation?.view ?: ConversationView.CHAT)
			val assistantWork by repo.assistantOps.work.collectAsState()
			val assistantSends by repo.assistantSendOps.pending.collectAsState()
			val assistantActs by repo.assistantActOps.pending.collectAsState()
			val assistantSendTileFor = remember(openTeam, assistantOpen, assistantSends) {
				if (assistantOpen) com.atelier_nyaarium.switchboard.assistant.assistantSendTile(assistantSends, gatewayOf(openTeam!!)) else null
			}
			val assistantActTileFor = remember(openTeam, assistantOpen, assistantActs) {
				if (assistantOpen) com.atelier_nyaarium.switchboard.assistant.assistantActTile(assistantActs, gatewayOf(openTeam!!)) else null
			}
			val sessionPrompts by repo.sessionPromptOps.prompts.collectAsState()
			val promptAnswers by repo.sessionPromptOps.answers.collectAsState()
			val waitingPrompt = waitingPromptOf(state, team)
			LaunchedEffect(team, waitingPrompt) {
				waitingPrompt?.let { repo.sessionPromptOps.keepLoaded(gatewayOf(team), team, it) }
			}
			val approvalFor = approvalView(waitingPrompt, sessionPrompts, promptAnswers)
			val chrome = threadChrome(
				assistant = assistantOpen,
				label = tabLabelFor(state, team),
				tabs = state.openTabs,
				sources = state.gateways.assistantOn(gatewayOf(team))?.let(::sourcesOf).orEmpty(),
			)
			SideDrawer(drawers = menuDrawer, sheet = menuSheet) {
			ThreadScreen(
				team = openTeam!!,
				onConversationShown = repo.phoneHoldOps::onConversationShown,
				label = tabLabelFor(state, openTeam!!),
				chrome = chrome,
				presence = presence,
				comet = cometOf(state, openTeam!!, System.currentTimeMillis()),
				tabs = state.openTabs,
				tabLabel = { tabLabelFor(state, it) },
				onReorderTabs = repo::reorderTabs,
				messages = state.threads[openTeam].orEmpty(),
				error = threadBanner(state.error, linkView(state), presence == SessionWord.WAKING),
				rendererPool = rendererPool,
				canRename = kind == "loose",
				openNonce = nav.generation,
				focusToken = summon?.id?.takeIf { focus == FocusStep.FIRE },
				onFocused = { SummonBus.step(it, Summon::focusSpent) },
				boardStrip = boardStripFor,
				boardLiveLine = boardLiveLineFor,
				boardRevision = boardRevision,
				boardStripHeight = boardStripHeight,
				onBoardStripHeight = { boardStripHeight = it; repo.store.boardStripHeight = it },
				onOpenBoardEntry = { boardModal = it.entry.id },
				onMoveBoardEntry = shellActions.moveBoardEntry,
				vaultTile = vaultTileFor,
				onOpenVaultRequest = { vaultModal = VaultModal.Request(it) },
				assistantSendTile = assistantSendTileFor,
				onOpenAssistantSend = { requestId -> assistantSendModal = gatewayOf(team) to requestId },
				assistantActTile = assistantActTileFor,
				onOpenAssistantAct = { requestId -> assistantActModal = gatewayOf(team) to requestId },
				approval = approvalFor,
				onApprove = { promptId ->
					shellScope.launch {
						repo.sessionPromptOps.answer(gatewayOf(team), team, promptId, PromptDecision.APPROVE, null)
					}
				},
				onDeny = { promptId, reason ->
					shellScope.launch {
						repo.sessionPromptOps.answer(gatewayOf(team), team, promptId, PromptDecision.DENY, reason)
					}
				},
				revealAt = revealAt,
				onRevealed = { revealAt = null },
				unreadBoundary = repo::unreadBoundary,
				onGateway = { t -> arriveAt(t, Arrival.TAB, null) },
				onCloseTab = { t, endSession ->
						// Leave closing tab before renderer removal.
					if (t == openTeam) {
						val next = state.openTabs.firstOrNull { it != t }
						nav = if (next == null) nav.leave() else nav.arrive(next, Arrival.CLOSED_TAB, factsFor(next))
					}
					if (endSession) repo.closeSession(t) else repo.closeTab(t)
				},
				onSessions = { nav = nav.up(backFacts) },
				onSettings = { nav = nav.openAssistantPage(AssistantPage.Settings) },
				inboxWork = { row -> assistantWork[WorkKey.Check(gatewayOf(team), row.sourceId)] ?: PageWork() },
				onCheckSource = { sourceId ->
					val gatewayId = gatewayOf(team)
					repo.command {
						assistantOps.runWork(WorkKey.Check(gatewayId, sourceId)) { answerText(checkNow(gatewayId, sourceId)) }
					}
				},
				onSourcePage = { sourceId -> nav = nav.openAssistantPage(AssistantPage.Source(gatewayOf(team), sourceId)) },
				composer = ComposerState(
					draft = state.drafts[openTeam!!] ?: Draft(),
					sendAwaitingWake = state.awaitingWake(openTeam!!),
					onSend = { repo.sendDraft(openTeam!!) },
					onTextChange = { repo.setDraftText(openTeam!!, it) },
					onAddFiles = { uris -> repo.command { addDraftFiles(openTeam!!, uris) } },
					onRemoveFile = { src -> repo.removeDraftFile(openTeam!!, src) },
						// Normalize draft and transcript attachments.
					onOpenFile = { file ->
						val rel = Attachments.relOf(file.src)
						val resolved = Attachments.fileFor(context.filesDir, file.src)
						if (rel != null && resolved != null) {
							viewer = OpenAttachment(
								resolved,
								file.name,
								file.mime,
								rel,
								file.size,
								file.modifiedAt,
								// Preserve draft file location.
								location = state.drafts[openTeam!!]?.locations?.get(file.src),
							)
						}
					},
					onAppendText = { insert -> repo.appendDraftText(openTeam!!, insert) },
					onClear = { repo.clearDraft(openTeam!!) },
				),
				scheduled = ScheduledSendState(
					record = state.scheduledSends[openTeam!!],
					onSchedule = { text, files, at -> repo.scheduled.scheduleSend(openTeam!!, text, files, at) },
					onReschedule = { at -> repo.scheduled.rescheduleSend(openTeam!!, at) },
					onCancel = { repo.scheduled.cancelScheduledSendForEdit(openTeam!!) },
				),
				goal = GoalState(
					offered = goalOffered(ConversationView.TERMINAL in offered, sessionCli),
					record = state.goals[openTeam!!],
					onArm = { g, text, files -> repo.goals.armAndSend(openTeam!!, g, text, files) },
					onCancel = { repo.goals.cancelGoal(openTeam!!) },
				),
				launch = LaunchState(
					error = state.launchErrors[openTeam!!]?.line,
					onDismissError = { repo.dismissLaunchError(openTeam!!) },
					container = containerAt(state, openTeam!!)?.run,
				),
				onRename = { name -> repo.command { rename(openTeam!!, name) } },
				onForget = { requestForget(openTeam!!, null) },
				// Use the same board forget gate.
				undoneTasks = if (boardOn) repo.boardOps.boardUndoneCountFor(openTeam!!) else 0,
				onForgetWithTasks = { cancelThem -> requestForget(openTeam!!, cancelThem) },
				terminal = TerminalState(
						// Peek uses presence freshness.
					presence = session?.presence,
						// Presence supplies login status before online.
					needsLogin = session?.presence?.needsLogin == true,
					limitBlocked = session?.presence?.limitBlocked == true,
					limitDetail = session?.presence?.limitDetail,
					compacting = session?.presence?.compacting == true,
					slashMacros = slashMacros(sessionCli),
					shellMacros = shellMacros(state.gateways.harnessesOnSession(openTeam!!)),
					paletteKeys = sendableKeys(PALETTE_KEYS, sessionCli),
					ctrlKeys = sendableKeys(CTRL_MENU_KEYS, sessionCli),
					onWake = { repo.sessions.wakeSession(openTeam!!) },
					onRelaunch = { repo.sessions.relaunchSession(openTeam!!) },
					refreshMs = repo.sessions.terminalRefreshMs,
					onPeek = { hash -> repo.sessions.peekTerminal(openTeam!!, hash) },
					onSend = { text, key, submit -> repo.sessions.tmuxSend(openTeam!!, text, key, submit) },
				),
				onKickPoll = repo::kickPoll,
				views = offered,
				view = shown,
				onView = { nav = nav.showView(it) },
				drawerSide = drawerSide,
				drawerBadged = anyBadge(menuBadges),
				onOpenDrawer = openMenu,
				body = { modifier ->
					com.atelier_nyaarium.switchboard.workspace.WorkspaceScreen(
						repo = repo,
						session = state.teams.firstOrNull { it.name == team },
						rosterLoaded = state.gateways.loaded,
						stack = nav.conversation?.files ?: listOf(WORKSPACE_ROOT),
						onPush = { nav = nav.pushFiles(it) },
						onJump = { nav = nav.jumpFiles(it) },
						onPop = { nav = nav.popFiles() },
						modifier = modifier,
					)
				},
			)
			}
		}
		ShellScreen.ROOT -> {
			val snackbarHostState = remember { SnackbarHostState() }
			// Transient failures use snackbar, once no editor covers it.
			LaunchedEffect(state.transientMessages, backFacts.editorOpen) {
				if (backFacts.editorOpen) return@LaunchedEffect
				state.transientMessages.firstOrNull()?.let {
					repo.sessions.consumeTransientMessage()
					snackbarHostState.showSnackbar(it)
				}
			}
			// Fold board once per revision.
			val boardOnHere = pluginManager.isActive("taskboard")
			val boardRevisionForCards by repo.boardOps.boardRevision
			val boardLines = remember(boardRevisionForCards, state.teams, boardOnHere) {
				if (!boardOnHere) emptyMap()
				else state.teams.associate { it.name to repo.boardOps.boardLiveLineFor(it.name) }
			}
			// Compute branches once per revision.
			val boardBranches = remember(boardRevisionForCards, state.teams, boardOnHere) {
				if (!boardOnHere) emptyMap()
				else state.teams.mapNotNull { team ->
					val line = boardLines[team.name] ?: return@mapNotNull null
					team.name to repo.boardOps.boardCardBranchFor(team.name, line.currentId)
				}.toMap()
			}
			val vaultOn = features.vault
			LaunchedEffect(vaultOn) { if (!vaultOn) editPolicy = null }
			// Grants re-read on the vault's own tick.
			val vaultRevision by repo.vault.revision
			val vaultTiers = remember(vaultRevision, state.teams, vaultOn) {
				if (!vaultOn) emptyMap() else state.teams.associate { it.name to repo.vaultOps.grantTierFor(it.name) }
			}
			// A pick made inside a session is drawn over it.
			val over = nav.over
			val overTeam = openTeam.takeIf { over != null }
			// The assistant's session filters nothing.
			val filterable = overTeam != null && !assistantOpen
			val filtered = filterable && over?.filtered == true
			val home = assistantGateway(state)
			val newAutomation = newAutomationOn(home, home?.let { state.gateways.assistantOn(it) })
			RootScreen(
				shown = nav.rootShown(offeredRoot),
				drawerSide = drawerSide,
				drawers = menuDrawer,
				sheet = menuSheet,
				drawerBadged = anyBadge(menuBadges),
				onOpenDrawer = openMenu,
				onBack = { nav = nav.back(BackLayer.OVER, backFacts, state.provisioned) }.takeIf { over != null },
				snackbarHostState = snackbarHostState,
				onRefresh = {
					repo.setup.retry()
					repo.command { presence.refreshTeams() }
						// Refresh retries non-route columns.
					repo.boardOps.refreshBoard()
					if (homeRead) repo.command { assistantOps.refreshShown() }
					when (nav.rootShown(offeredRoot)) {
						RootView.SOURCES -> for (gatewayId in state.gateways.ids()) repo.command { deviceOps.refresh(gatewayId) }
						RootView.AUTOMATIONS -> repo.command { automationOps.refreshAll() }
						else -> Unit
					}
				},
				onAssistantSettings = { nav = nav.openAssistantPage(AssistantPage.Settings) }.takeIf { rootOffersSettings(assistantRoot) },
				queueState = queueState,
				onQueue = { openQueueRequest.value = true },
				viewActions = { view ->
					when {
						view == RootView.SOURCES && home != null ->
							Button(onClick = hapticClick { nav = nav.openAssistantPage(AssistantPage.Add) }) { Text("Add") }
						view == RootView.AUTOMATIONS && newAutomation != null ->
							Button(
								onClick = hapticClick {
									nav = nav.openAssistantPage(
										AssistantPage.AutomationEditor(newAutomation, com.atelier_nyaarium.switchboard.assistant.AutomationSlot.New),
									)
								},
							) { Text("New") }
					}
				},
			) { view, modifier ->
				val scoped = view.scoped
				if (scoped != null) {
					androidx.compose.foundation.layout.Column(modifier) {
						if (overTeam != null && filterable) {
							FilterRow(tabLabelFor(state, overTeam), filtered) { nav = nav.filter(it) }
						}
						ScopedViewBody(
							view = scoped,
							scope = if (overTeam != null && filtered) ViewScope.Session(overTeam) else ViewScope.Everything,
							repo = repo,
							state = state,
							actions = shellActions,
							modifier = Modifier.weight(1f),
							onBoardSaved = { nav = nav.boardSaved() },
						)
					}
				} else if (view == RootView.ASSISTANT) {
					com.atelier_nyaarium.switchboard.assistant.AssistantRootScreen(
						root = assistantRoot,
						onSettings = { nav = nav.openAssistantPage(AssistantPage.Settings) },
						modifier = modifier,
					)
				} else if (view == RootView.SOURCES) {
					com.atelier_nyaarium.switchboard.assistant.SourcesView(
						repo = repo,
						state = state,
						home = home,
						lead = overTeam?.let(::gatewayOf),
						onDevice = { g, d -> nav = nav.openAssistantPage(AssistantPage.Device(g, d)) },
						onService = { g, s -> nav = nav.openAssistantPage(AssistantPage.Entry(g, s)) },
						onSource = { g, s -> nav = nav.openAssistantPage(AssistantPage.Source(g, s)) },
						modifier = modifier,
					)
				} else if (view == RootView.AUTOMATIONS) {
					com.atelier_nyaarium.switchboard.assistant.AutomationsView(
						repo = repo,
						state = state,
						home = home,
						lead = overTeam?.let(::gatewayOf),
						onEdit = { g, slot -> nav = nav.openAssistantPage(AssistantPage.AutomationEditor(g, slot)) },
						modifier = modifier,
					)
				} else {
					SessionsScreen(
						state = state,
						modifier = modifier,
						onRefresh = {
							repo.setup.retry()
							repo.command { presence.refreshTeams() }
						},
						onManage = { openOverlay(Overlay.Manage) },
						onAddGateway = { openOverlay(Overlay.AddGateway) },
						onHostHelp = { openOverlay(Overlay.HostHelp) },
						onOpen = { team -> arriveAt(team, Arrival.OUTSIDE, null) },
						onRename = { team, name -> repo.command { rename(team, name) } },
						onMarkRead = { team -> repo.markRead(team) },
						onForget = { team -> requestForget(team, null) },
						// Spawn stays on board; next poll reveals session.
						onSpawn = { target, label, workdir, harness ->
							repo.command { sessions.spawnSession(target, label, workdir, harness) }
						},
						onStartContainer = { target -> repo.containers.start(target) },
						onStopContainer = { target -> repo.containers.stop(target) },
						onListDirs = { path, hostTarget, spawn -> repo.sessions.listDirs(path, hostTarget, spawn) },
						// Offer pending enrollment verification.
						onVerifyEnroll = (if (state.provisioned) repo.ceremony.pendingEnrolleeCeremony() else null)
							?.let { c -> { openOverlay(Overlay.EnrolleeCeremony(c)) } },
						// Router endpoint opens Federation.
						onRouterEndpoint = { nav = nav.openSettings(SettingsRoute.FEDERATION) },
						boardLine = { team -> boardLines[team.name] },
						boardBranch = { team -> boardBranches[team.name] },
						vaultTier = { team -> vaultTiers[team.name] },
						undoneFor = { team ->
							if (pluginManager.isActive("taskboard")) {
								repo.boardOps.boardUndoneCountFor(team.name)
							} else 0
						},
						onForgetWithTasks = { team, cancelThem -> requestForget(team, cancelThem) },
					)
				}
			}
		}
	}

	QueueOverlay(repo, openQueueRequest, locked, revealAtState, openTeamRequest)
	if (!locked) {
		AttachmentViewerOverlay(viewerState, rendererPool)
		LinkMenuDialog(linkMenuState, linkMenuNoteState)
		RowMenuDialog(repo, rowPressState, pluginManager.host::cutClaims)
	}
	// Board dialog replaces current screen.
	if (!locked) boardModal?.let { entryId ->
		BoardEntryDialog(state, repo, entryId) { boardModal = null }
	}
	// Cards wait for unlock.
	val cardsShow = requestCardsShow(locked)
	when (val modal = vaultModal) {
		is VaultModal.Entry -> if (!locked) {
			com.atelier_nyaarium.switchboard.vault.VaultEntryDialog(repo, state, modal.id) { vaultModal = null }
		}
		is VaultModal.Request -> if (cardsShow) {
			com.atelier_nyaarium.switchboard.vault.VaultRequestSheet(repo, state, modal.id) { vaultModal = null }
		}
		null -> {}
	}
	if (cardsShow) {
		assistantSendModal?.let { (gatewayId, requestId) ->
			com.atelier_nyaarium.switchboard.assistant.AssistantSendSheet(repo, gatewayId, requestId) { assistantSendModal = null }
		}
		assistantActModal?.let { (gatewayId, requestId) ->
			com.atelier_nyaarium.switchboard.assistant.AssistantActSheet(repo, gatewayId, requestId) { assistantActModal = null }
		}
	}
	// Nothing draws over the lock; a parked edit returns with its editor.
	if (locked) return
	fireRunbook?.let { fire ->
		com.atelier_nyaarium.switchboard.runbooks.RunbookFireSheet(repo, state, fire.gatewayId, fire.id, fire.into) { fireRunbook = null }
	}
	editRunbook?.let { opened ->
		val key = editKeyOf(opened)
		com.atelier_nyaarium.switchboard.runbooks.RunbookEditor(repo, key.gatewayId, key.id) { editRunbook = null }
	}
	editRoutine?.let { opened ->
		val key = editKeyOf(opened)
		com.atelier_nyaarium.switchboard.routines.RoutineEditor(repo, state, key.gatewayId, key.id) { editRoutine = null }
	}
	editPolicy?.let { opened ->
		val key = editKeyOf(opened)
		com.atelier_nyaarium.switchboard.policies.PolicyEditor(repo, state, key.gatewayId, key.id) { editPolicy = null }
	}
}

/** An open editor's saved pair; a blank id is a new record. */
private fun editKeyOf(opened: Pair<String, String>?): EditKey = EditKey(opened?.first.orEmpty(), opened?.second?.ifEmpty { null })


/** Log and skip plugin claim errors. */
internal fun logPluginThrow(message: String, err: Throwable) {
	DebugLog.log("Plugins", "$message: $err")
}
