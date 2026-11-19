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
import com.atelier_nyaarium.switchboard.assistant.newAutomationGateways
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
			).also { built ->
				// Runs whatever screen is up.
				built.onWiped = {
					Plugins.get(app).host.accountWipeHandlers.forEachCaught(onError = ::logPluginThrow) { it.onWipe(app) }
					ServiceNotifications.cancelProvisioningNotifications(app)
				}
				instance = built
			}
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
				var noticeAt by remember { mutableStateOf(NoticeAt.NONE) }
				NoticeFrame(repo, noticeAt) {
					App(
						repo,
						injected,
						openTeamRequest,
						openQueueRequest,
						vaultRequestRequest,
						assistantSendRequestRequest,
						assistantActRequestRequest,
						onNoticeAt = { noticeAt = it },
					)
				}
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
		if (isFinishing) {
			AppLock.relock()
			// The edit outlives the window; the open editor does not.
			Repo.get(this).editors.hideAll()
		}
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
	/** Where the drawn screen wants notices; the frame above draws the shell's strip. */
	onNoticeAt: (NoticeAt) -> Unit = {},
) {
	val state by repo.state.collectAsState()
	val bootState by repo.bootState.collectAsState()
	val missingBoot = bootState as? BootState.Missing
	val context = LocalContext.current
	val activity = context.fragmentActivity()
	var nav by rememberSaveable(stateSaver = ShellNav.saver) { mutableStateOf(ShellNav()) }
	val heldTeam = nav.heldTeam
	// Composition mirror; store persists.
	var boardStripHeight by remember { mutableStateOf(repo.store.boardStripHeight) }
	var modals by remember { mutableStateOf(Modals()) }
	val runbookEdits by repo.runbookOps.edits.state.collectAsState()
	val routineEdits by repo.routineOps.edits.state.collectAsState()
	val policyEdits by repo.policyOps.edits.state.collectAsState()
	val automationEdits by repo.automationOps.edits.state.collectAsState()
	val shownEditor = shownEditorOf(runbookEdits.shown, routineEdits.shown, policyEdits.shown, automationEdits.shown)
	var drawerSide by remember { mutableStateOf(repo.store.drawerSide) }
	val shellScope = rememberCoroutineScope()
	val menuDrawer = remember { SideDrawers() }
	val shellActions = ShellActions(
		openBoardEntry = { modals = modals.copy(board = it) },
		moveBoardEntry = { row, drop -> repo.boardOps.boardMove(row.entry.id, drop.parent, drop.index) },
		openVaultEntry = { modals = modals.copy(vault = VaultModal.Entry(it)) },
		openVaultRequest = { modals = modals.copy(vault = VaultModal.Request(it)) },
		fireRunbook = { gatewayId, id, into -> modals = modals.copy(fire = RunbookFire(gatewayId, id, into)) },
		editRunbook = { gatewayId, id -> repo.editors.show(ShownEditor.Runbook(EditKey(gatewayId, id))) },
		editRoutine = { gatewayId, id -> repo.editors.show(ShownEditor.Routine(EditKey(gatewayId, id))) },
		editPolicy = { gatewayId, id -> repo.editors.show(ShownEditor.Policy(EditKey(gatewayId, id))) },
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
	// Leave once the forget commits.
	SideEffect { forgetSession.onForgotten = { forgotten -> nav = nav.forgot(forgotten) } }
	val requestForget = { team: String, cancelTasks: Boolean? ->
		when (val ask = forgetSession.ask(team)) {
			ForgetAsk.None -> forgetSession.forget(team, cancelTasks)
			else -> modals = modals.copy(forget = ForgetAsking(team, cancelTasks, ask))
		}
	}

	val viewerState = remember { mutableStateOf<OpenAttachment?>(null) }
	var viewer by viewerState
	val linkMenuState = remember { mutableStateOf<Pair<String, String>?>(null) }
	val linkMenuNoteState = remember { mutableStateOf<String?>(null) }
	val rowPressState = remember { mutableStateOf<RowPress?>(null) }
	val rendererPool = rememberBoundRendererPool(repo, pluginManager, viewerState, linkMenuState, linkMenuNoteState, rowPressState)
	val overlayRequests = remember {
		OverlayRequests(viewerState, linkMenuState, linkMenuNoteState, rowPressState, openQueueRequest, revealAtState, openTeamRequest)
	}

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
	val offeredConversation = heldTeam?.let(offeredFor).orEmpty()
	val assistantOpen = heldTeam?.let { isAssistant(state, it) } == true
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
		repo.editors.hideAll()
		modals = Modals()
		overlayRequests.close()
	}
	// Leaves before wipe answers.
	val provisioned = state.provisioned
	var wasProvisioned by rememberSaveable { mutableStateOf(provisioned) }
	LaunchedEffect(provisioned) {
		if (wasProvisioned && !provisioned) {
			dismissForArrival()
			nav = ShellNav()
		}
		wasProvisioned = provisioned
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
	LaunchedEffect(assistantRoot, nav) {
		nav = nav.enterAssistant(assistantRoot, factsFor)
	}
	val deviceViews by repo.deviceOps.views.collectAsState()
	LaunchedEffect(assistantRoot, nav, state.gateways, deviceViews, offeredRoot) {
		nav = nav.followAssistant(assistantRoot, state).resolvePages(state) { deviceViews[it]?.list }.offering(offeredRoot)
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
			modals = modals.copy(vault = VaultModal.Request(requestId))
			vaultRequestRequest.value = null
		}
	}

	LaunchedEffect(assistantSendRequestRequest.value) {
		assistantSendRequestRequest.value?.let { request ->
			dismissForArrival()
			modals = modals.copy(send = request)
			assistantSendRequestRequest.value = null
		}
	}

	LaunchedEffect(assistantActRequestRequest.value) {
		assistantActRequestRequest.value?.let { request ->
			dismissForArrival()
			modals = modals.copy(act = request)
			assistantActRequestRequest.value = null
		}
	}

	LaunchedEffect(heldTeam) {
		if (heldTeam == null) repo.kickPoll()
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

	val shellFacts = ShellFacts(
		editorOpen = shownEditor != null,
		locked = locked,
		overlayOpen = overlays.isNotEmpty(),
		booted = missingBoot == null,
		drawerOpen = menuDrawer.holdsBack(),
		offeredRoot = offeredRoot,
		offeredConversation = offeredConversation,
		assistantOpen = assistantOpen,
	)
	val screen = nav.drawn(shellFacts)
	val noticePlace = noticeAt(screen, shellFacts.editorOpen)
	SideEffect { onNoticeAt(noticePlace) }
	val assistantShown = showsAssistant(screen)
	LaunchedEffect(assistantShown) {
		if (assistantShown) repo.phoneHoldOps.onAssistantShown()
	}
	val sourcesMoved by repo.assistantOps.sourcesMoved.collectAsState()
	val homeReader = homeReadKey(screen)
	LaunchedEffect(homeVersions(state), state.gateways.incarnations(), state.gateways.reachableIds(), state.router.settled, homeReader, sourcesMoved) {
		if (homeReader == null) return@LaunchedEffect
		// Covers a screen before the first drain.
		repo.assistantOps.refreshShown()
	}
	// A drawer left open never reappears open. On the shell's scope: a return cancels this effect.
	LaunchedEffect(screen.kind in MENU_SCREENS) {
		if (screen.kind !in MENU_SCREENS && menuDrawer.holdsBack()) shellScope.launch { menuDrawer.snapClosed() }
	}
	val stands = editorStands(shownEditor, features.vault, repo.automationOps::editsEvent) { assistantLeft(state, it) }
	LaunchedEffect(stands) { if (!stands) repo.editors.hideAll() }
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
			shown = menuShown(screen),
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
	val composerShown = (screen as? Drawn.Conversation)?.let { state.scheduledSends[it.team] == null } == true
	val shownToSummon = summonShown(screen, assistantRoot, composerShown, covered = menuDrawer.holdsBack())
	val focus = focusStep(summon, shownToSummon, windowFocused, resumed)
	LaunchedEffect(focus, summon?.id) {
		if (focus == FocusStep.DROP) summon?.let { SummonBus.step(it.id, Summon::focusSpent) }
	}
	// The one Back authority: `backLayer` orders what is drawn over what.
	val layer = backLayer(screen, shellFacts)
	BackHandler(enabled = layer != null) {
		when (layer) {
			// A changed draft asks first.
			BackLayer.EDITOR -> repo.editors.askLeave()
			BackLayer.OVERLAY -> closeOverlay()
			BackLayer.DRAWER -> shellScope.launch { menuDrawer.close() }
			null -> Unit
			else -> nav = nav.back(layer, shellFacts, state.provisioned)
		}
	}

	when (screen) {
		Drawn.Lock -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) AppLock.unlock() } } })
		Drawn.Overlay -> OverlayHost(overlays.last(), repo, state, openOverlay, closeOverlay)
		// Settings remains reachable before provisioning.
		is Drawn.Settings ->
			SettingsScreen(
				state = state,
				repo = repo,
				plugins = pluginManager,
				route = screen.route,
				onRoute = { nav = nav.openSettings(it) },
				onSetDeviceName = { repo.command { setDeviceName(it) } },
				onToggleBiometric = { repo.setBiometricLock(it) },
				onManage = { openOverlay(Overlay.Manage) },
				onYourDevices = { openOverlay(Overlay.YourDevices) },
				onFederation = { openOverlay(Overlay.Users) },
				// Close Settings first.
				onAssistant = { nav = nav.closeSettings().push(ShellPage.Settings) },
				onCloseSettings = { nav = nav.closeSettings() },
				drawerSide = drawerSide,
				onDrawerSide = {
					drawerSide = it
					repo.store.drawerSide = it
				},
			)
		Drawn.Boot -> when {
			Need.PROVISIONING in missingBoot?.needs.orEmpty() ->
				ProvisionScreen(
					repo = repo,
					onProvision = { blob, refused -> repo.command { provision(blob)?.let(refused) } },
					onSettings = { nav = nav.openSettings() },
					onFederation = { nav = nav.openSettings(SettingsRoute.FEDERATION) },
				)
			else -> DomainConnectingScreen(onSettings = { nav = nav.openSettings() })
		}
		is Drawn.Page ->
			assistantPages.SaveableStateProvider(pageKey(screen.page)) {
				com.atelier_nyaarium.switchboard.assistant.AssistantPageHost(
					repo = repo,
					state = state,
					page = screen.page,
					home = assistantGateway(state),
					onListDirs = { path, hostTarget, spawn -> repo.sessions.listDirs(path, hostTarget, spawn) },
					onPage = { nav = nav.push(it) },
					onReplace = { nav = nav.replaceTop(it) },
					onRoot = { nav = nav.toRoot(it, assistantOpen) },
					onBack = { nav = nav.back(BackLayer.PAGE, shellFacts, state.provisioned) },
				)
			}
		is Drawn.Conversation -> {
			val team = screen.team
			// Devcontainer names are fixed.
			val session = state.sessions().firstOrNull { it.name == team }
			val sessionCli = harnessOf(session)
			val kind = session?.kind
			// Rename only known loose sessions.
			val presence = session?.let { state.sessionWord(it.name, it.presence, System.currentTimeMillis()) }
			val boardOn = pluginManager.isActive("taskboard")
			val boardTeam = state.teams.firstOrNull { it.name == team }
			val boardKey = boardTeam?.let { GroupKey(it.domainId, it.gatewayId, repo.boardOps.boardSessionKeyOf(team)) }
			LaunchedEffect(team, boardOn, boardKey) {
				if (boardOn) repo.boardOps.refreshBoard()
			}
			val boardRevision by repo.boardOps.boardRevision
				// Failed reads do not advance revision.
			val boardStripFor = remember(team, boardRevision, boardOn, boardKey) {
				if (boardOn) repo.boardOps.boardGroupFor(team) else null
			}
			val boardLiveLineFor = remember(team, boardRevision, boardOn, boardKey) {
				if (boardOn) repo.boardOps.boardLiveLineFor(team) else null
			}
			// The overlay draws over this screen, so a request it is already showing is not tiled
			// again underneath it.
			val promptShowing by repo.vault.promptShowing.collectAsState()
			val vaultRevision by repo.vault.revision
			val vaultTileFor = remember(team, vaultPending, promptShowing, vaultRevision) {
				vaultPending
					.firstOrNull { it.team == team && it.requestId != promptShowing }
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
			val offered = offeredConversation
			val shown = screen.view
			val assistantWork by repo.assistantOps.work.collectAsState()
			val assistantSends by repo.assistantSendOps.pending.collectAsState()
			val assistantActs by repo.assistantActOps.pending.collectAsState()
			val assistantSendTileFor = remember(team, assistantOpen, assistantSends) {
				if (assistantOpen) com.atelier_nyaarium.switchboard.assistant.assistantSendTile(assistantSends, gatewayOf(team)) else null
			}
			val assistantActTileFor = remember(team, assistantOpen, assistantActs) {
				if (assistantOpen) com.atelier_nyaarium.switchboard.assistant.assistantActTile(assistantActs, gatewayOf(team)) else null
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
				home = state.gateways.assistantRead(gatewayOf(team)),
			)
			SideDrawer(drawers = menuDrawer, sheet = menuSheet) {
			ThreadScreen(
				team = team,
				onConversationShown = repo.phoneHoldOps::onConversationShown,
				label = tabLabelFor(state, team),
				chrome = chrome,
				presence = presence,
				comet = cometOf(state, team, System.currentTimeMillis()),
				tabs = state.openTabs,
				tabLabel = { tabLabelFor(state, it) },
				onReorderTabs = repo::reorderTabs,
				messages = state.threads[team].orEmpty(),
				banner = threadBanner(linkView(state), presence == SessionWord.WAKING),
				notices = if (noticePlace.host == NoticeHost.THREAD) {
					noticeLines(state.notices, team) { tabLabelFor(state, it) }
				} else emptyList(),
				onDismissNotice = repo::dismissNotice,
				onClearNotices = repo::clearNotices,
				rendererPool = rendererPool,
				canRename = kind == "loose",
				openNonce = screen.openNonce,
				focusToken = summon?.id?.takeIf { focus == FocusStep.FIRE },
				onFocused = { SummonBus.step(it, Summon::focusSpent) },
				boardStrip = boardStripFor,
				boardLiveLine = boardLiveLineFor,
				boardRevision = boardRevision,
				boardStripHeight = boardStripHeight,
				onBoardStripHeight = { boardStripHeight = it; repo.store.boardStripHeight = it },
				onOpenBoardEntry = { modals = modals.copy(board = it.entry.id) },
				onMoveBoardEntry = shellActions.moveBoardEntry,
				vaultTile = vaultTileFor,
				onOpenVaultRequest = { modals = modals.copy(vault = VaultModal.Request(it)) },
				assistantSendTile = assistantSendTileFor,
				onOpenAssistantSend = { requestId -> modals = modals.copy(send = gatewayOf(team) to requestId) },
				assistantActTile = assistantActTileFor,
				onOpenAssistantAct = { requestId -> modals = modals.copy(act = gatewayOf(team) to requestId) },
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
					if (t == team) {
						val next = state.openTabs.firstOrNull { it != t }
						nav = if (next == null) nav.leave() else nav.arrive(next, Arrival.CLOSED_TAB, factsFor(next))
					}
					if (endSession) repo.closeSession(t) else repo.closeTab(t)
				},
				onSessions = { nav = nav.up(shellFacts) },
				onSettings = { nav = nav.push(ShellPage.Settings) },
				inboxWork = { row -> assistantWork[WorkKey.Check(gatewayOf(team), row.sourceId)] ?: PageWork() },
				onCheckSource = { sourceId ->
					val gatewayId = gatewayOf(team)
					repo.command {
						assistantOps.runWork(WorkKey.Check(gatewayId, sourceId)) { answerText(checkNow(gatewayId, sourceId)) }
					}
				},
				onSourcePage = { sourceId -> nav = nav.push(ShellPage.Source(gatewayOf(team), sourceId)) },
				composer = ComposerState(
					draft = state.drafts[team] ?: Draft(),
					sendAwaitingWake = state.awaitingWake(team),
					onSend = { repo.sendDraft(team) },
					onTextChange = { repo.setDraftText(team, it) },
					onAddFiles = { uris -> repo.command { addDraftFiles(team, uris) } },
					onRemoveFile = { src -> repo.removeDraftFile(team, src) },
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
								location = state.drafts[team]?.locations?.get(file.src),
							)
						}
					},
					onAppendText = { insert -> repo.appendDraftText(team, insert) },
					onClear = { repo.clearDraft(team) },
				),
				scheduled = ScheduledSendState(
					record = state.scheduledSends[team],
					onSchedule = { text, files, at -> repo.scheduled.scheduleSend(team, text, files, at) },
					onReschedule = { at -> repo.scheduled.rescheduleSend(team, at) },
					onCancel = { repo.scheduled.cancelScheduledSendForEdit(team) },
					onDue = { repo.scheduled.kickDrain() },
				),
				goal = GoalState(
					offered = goalOffered(ConversationView.TERMINAL in offered, sessionCli),
					record = state.goals[team],
					onArm = { g, text, files -> repo.goals.armAndSend(team, g, text, files) },
					onCancel = { repo.goals.cancelGoal(team) },
				),
				launch = LaunchState(
					error = state.launchErrors[team]?.line,
					onDismissError = { repo.dismissLaunchError(team) },
					container = containerAt(state, team)?.run,
				),
				onRename = { name -> repo.command { rename(team, name) } },
				onForget = { requestForget(team, null) },
				// Use the same board forget gate.
				undoneTasks = if (boardOn) repo.boardOps.boardUndoneCountFor(team) else 0,
				onForgetWithTasks = { cancelThem -> requestForget(team, cancelThem) },
				terminal = TerminalState(
						// Peek uses presence freshness.
					presence = session?.presence,
						// Presence supplies login status before online.
					needsLogin = session?.presence?.needsLogin == true,
					limitBlocked = session?.presence?.limitBlocked == true,
					limitDetail = session?.presence?.limitDetail,
					compacting = session?.presence?.compacting == true,
					slashMacros = slashMacros(sessionCli),
					shellMacros = shellMacros(state.gateways.harnessesOnSession(team)),
					paletteKeys = sendableKeys(PALETTE_KEYS, sessionCli),
					ctrlKeys = sendableKeys(CTRL_MENU_KEYS, sessionCli),
					onWake = { repo.sessions.wakeSession(team) },
					onRelaunch = { repo.sessions.relaunchSession(team) },
					refreshMs = repo.sessions.terminalRefreshMs,
					onPeek = { hash -> repo.sessions.peekTerminal(team, hash) },
					onSend = { text, key, submit -> repo.sessions.tmuxSend(team, text, key, submit) },
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
						stack = screen.files,
						onPush = { nav = nav.pushFiles(it) },
						onJump = { nav = nav.jumpFiles(it) },
						onPop = { nav = nav.popFiles() },
						modifier = modifier,
					)
				},
			)
			}
		}
		is Drawn.Root -> {
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
			// Grants re-read on the vault's own tick.
			val vaultRevision by repo.vault.revision
			val vaultTiers = remember(vaultRevision, state.teams, vaultOn) {
				if (!vaultOn) emptyMap() else state.teams.associate { it.name to repo.vaultOps.grantTierFor(it.name) }
			}
			// A pick made inside a session is drawn over it.
			val over = screen.over
			val home = assistantGateway(state)
			val newAutomations = newAutomationGateways(state.gateways, ViewScope.Everything.newOn(state.gateways), state.assistantHome)
			RootScreen(
				shown = screen.view,
				drawerSide = drawerSide,
				drawers = menuDrawer,
				sheet = menuSheet,
				drawerBadged = anyBadge(menuBadges),
				onOpenDrawer = openMenu,
				onBack = { nav = nav.back(BackLayer.OVER, shellFacts, state.provisioned) }.takeIf { over != null },
				onRefresh = {
					repo.setup.retry()
					repo.command { presence.refreshTeams() }
						// Refresh retries non-route columns.
					repo.boardOps.refreshBoard()
					if (homeReader != null) repo.command { assistantOps.refreshShown() }
					when (screen.view) {
						RootView.SOURCES -> for (gatewayId in state.gateways.ids()) repo.command { deviceOps.refresh(gatewayId) }
						RootView.AUTOMATIONS -> repo.command { automationOps.refreshAll() }
						RootView.ROUTINES -> repo.command { routineOps.refreshAll() }
						RootView.RUNBOOKS -> repo.command { runbookOps.refreshAll() }
						RootView.POLICIES -> repo.command { policyOps.refreshAll() }
						else -> Unit
					}
				},
				onAssistantSettings = { nav = nav.push(ShellPage.Settings) }.takeIf { rootOffersSettings(assistantRoot) },
				queueState = queueState,
				onQueue = { openQueueRequest.value = true },
				viewActions = { view ->
					when {
						view == RootView.SOURCES && home != null ->
							Button(onClick = hapticClick { nav = nav.push(ShellPage.Add) }) { Text("Add") }
						view == RootView.AUTOMATIONS ->
							NewOnGatewayButton(newAutomations, "New automation") { gatewayId ->
								val slot = com.atelier_nyaarium.switchboard.assistant.AutomationSlot.New()
								repo.editors.show(ShownEditor.Automation(AutomationDraftKey(gatewayId, slot)))
							}
					}
				},
			) { view, modifier ->
				val scoped = view.scoped
				if (scoped != null) {
					androidx.compose.foundation.layout.Column(modifier) {
						if (over != null && over.filterable) {
							FilterRow(tabLabelFor(state, over.team), over.scope is ViewScope.Session) { nav = nav.filter(it) }
						}
						ScopedViewBody(
							view = scoped,
							scope = over?.scope ?: ViewScope.Everything,
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
						onSettings = { nav = nav.push(ShellPage.Settings) },
						modifier = modifier,
					)
				} else if (view == RootView.SOURCES) {
					com.atelier_nyaarium.switchboard.assistant.SourcesView(
						repo = repo,
						state = state,
						home = home,
						lead = over?.team?.let(::gatewayOf),
						onDevice = { g, d -> nav = nav.push(ShellPage.Device(g, d)) },
						onService = { g, s -> nav = nav.push(ShellPage.Entry(g, s)) },
						onSource = { g, s -> nav = nav.push(ShellPage.Source(g, s)) },
						modifier = modifier,
					)
				} else if (view == RootView.AUTOMATIONS) {
					com.atelier_nyaarium.switchboard.assistant.AutomationsView(
						repo = repo,
						state = state,
						home = home,
						lead = over?.team?.let(::gatewayOf),
						onEdit = { g, slot -> repo.editors.show(ShownEditor.Automation(AutomationDraftKey(g, slot))) },
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

	ShellOverlays(
		locked = locked,
		repo = repo,
		state = state,
		modals = modals,
		onModals = { change -> modals = change(modals) },
		editor = shownEditor,
		requests = overlayRequests,
		rendererPool = rendererPool,
		forgetSession = forgetSession,
		claimsOf = pluginManager.host::cutClaims,
	)
}

/** Log and skip plugin claim errors. */
internal fun logPluginThrow(message: String, err: Throwable) {
	DebugLog.log("Plugins", "$message: $err")
}
