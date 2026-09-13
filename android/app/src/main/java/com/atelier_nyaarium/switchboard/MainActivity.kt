package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
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

	fun get(context: Context): ChatRepository =
		instance ?: synchronized(this) {
			val app = context.applicationContext
			instance ?: ChatRepository(
				AppStateStore(app),
				app.filesDir,
				app.contentResolver,
				loadSttsCatalog(app),
			).also { instance = it }
		}

	/** Malformed catalog means empty. */
	private fun loadSttsCatalog(app: Context): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> =
		runCatching {
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

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		DebugLog.init(this)
		val repo = Repo.get(this)
		val injected = intent.getStringExtra("provisioning_b64")
			?.let { runCatching { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }.getOrNull() }
		consume(intent)
		setContent {
			val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
			MaterialTheme(colorScheme = colors) { App(repo, injected, openTeamRequest, openQueueRequest, vaultRequestRequest) }
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent)
		consume(intent)
	}

	/** Remove one-shot extras after consumption. */
	private fun consume(intent: Intent) {
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
	}
}

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
) {
	val state by repo.state.collectAsState()
	val bootState by repo.bootState.collectAsState()
	val missingBoot = bootState as? BootState.Missing
	val context = LocalContext.current
	val activity = context as? FragmentActivity
	var nav by rememberSaveable(stateSaver = ShellNavSaver) { mutableStateOf(ShellNav()) }
	val openTeam = nav.conversation?.team
	// Composition mirror; store persists.
	var boardStripHeight by remember { mutableStateOf(repo.store.boardStripHeight) }
	var boardModal by remember { mutableStateOf<String?>(null) }
	var vaultModal by remember { mutableStateOf<VaultModal?>(null) }
	var fireRunbook by remember { mutableStateOf<RunbookFire?>(null) }
	// Gateway and id. Null is closed, a blank id is a new one.
	var editRunbook by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
	var editRoutine by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
	var editPolicy by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
	var drawerSide by remember { mutableStateOf(repo.store.drawerSide) }
	val shellScope = rememberCoroutineScope()
	val shellActions = ShellActions(
		openBoardEntry = { boardModal = it },
		moveBoardEntry = { row, drop -> repo.boardOps.boardSetParent(row.entry.id, drop.parent, drop.rank) },
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
	var unlocked by remember { mutableStateOf(false) }

	// Initialize plugins before registry reads.
	val pluginManager = remember { Plugins.get(context) }

	val viewerState = remember { mutableStateOf<OpenAttachment?>(null) }
	var viewer by viewerState
	val linkMenuState = remember { mutableStateOf<Pair<String, String>?>(null) }
	val linkMenuNoteState = remember { mutableStateOf<String?>(null) }
	val rendererPool = rememberBoundRendererPool(repo, pluginManager, viewerState, linkMenuState, linkMenuNoteState)

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
		repo.onForeground()
		rendererPool.setVisible(true)
		repo.command { reconcilePending() }
		onStopOrDispose {
			repo.onBackground()
			rendererPool.setVisible(false)
		}
	}
	val features = DrawerFeatures(board = pluginManager.isActive("taskboard"), vault = pluginManager.isActive("vault"))
	val offeredRoot = rootViews(features)
	val offeredConversation = openTeam?.let { conversationViews(features, terminalEligible(state, it)) }.orEmpty()
	val factsFor = { team: String ->
		ArrivalFacts(
			offered = conversationViews(features, terminalEligible(state, team)),
			stuckAtLogin = stuckAtLogin(state.sessions().firstOrNull { it.name == team }?.presence),
		)
	}
	// A ref's exit opens Files. Clearing first prevents duplicate routing.
	val workspaceRequest by com.atelier_nyaarium.switchboard.workspace.WorkspaceOpenBus.pending.collectAsState()
	LaunchedEffect(workspaceRequest, state.teams, state.gateways.loaded) {
		val request = workspaceRequest ?: return@LaunchedEffect
		val standing = standingOf(state.teams, state.gateways.loaded, request.team)
		if (standing == RequestStanding.Wait) return@LaunchedEffect
		com.atelier_nyaarium.switchboard.workspace.WorkspaceOpenBus.shown(request)
		val row = state.teams.firstOrNull { it.name == request.team }
		val opened = if (standing == RequestStanding.Show) repo.openThread(request.team) else null
		if (row == null || opened == null) return@LaunchedEffect
		val place = when (val open = request.open) {
			is com.atelier_nyaarium.switchboard.workspace.WorkspaceOpen.File -> WorkspacePlace.Outline(open.path)
			is com.atelier_nyaarium.switchboard.workspace.WorkspaceOpen.Window -> {
				// This effect ends when the bus clears, so use the shell scope.
				shellScope.launch { repo.windowOps.openWindow(targetOf(row), open.symbolId) }
				WorkspacePlace.Windows
			}
		}
		nav = nav.arrive(opened, Arrival.FILES_ASKED, factsFor(opened), place)
	}
	LaunchedEffect(openTeamRequest.value) {
		openTeamRequest.value?.let { team ->
			val opened = repo.openThread(team) ?: return@let
			overlays = emptyList()
			nav = nav.arrive(opened, Arrival.OUTSIDE, factsFor(opened))
			openTeamRequest.value = null
		}
	}

	// A notification tap opens the request.
	LaunchedEffect(vaultRequestRequest.value) {
		vaultRequestRequest.value?.let { requestId ->
			nav = nav.closeSettings()
			overlays = emptyList()
			vaultModal = VaultModal.Request(requestId)
			vaultRequestRequest.value = null
		}
	}

	// Board focus drives daemon cadence.
	LaunchedEffect(openTeam) {
		if (openTeam == null) repo.declareFocus(FocusIntent(screen = "board"))
	}

	val locked = state.provisioned && state.biometricLock && !unlocked
	LaunchedEffect(locked) {
		if (locked && activity != null) promptUnlock(activity) { ok -> if (ok) unlocked = true }
	}

	val screen = shellScreen(nav, locked, overlays.isNotEmpty(), missingBoot == null)
	// One state per showing of its screen, so a drawer left open never reappears open.
	val rootDrawer = remember(screen == ShellScreen.ROOT) { SideDrawers() }
	val conversationDrawer = remember(screen == ShellScreen.CONVERSATION, openTeam) { SideDrawers() }
	// The one Back authority: `backLayer` orders what is drawn over what.
	val shownDrawer = if (screen == ShellScreen.CONVERSATION) conversationDrawer else rootDrawer
	val backFacts = BackFacts(
		editorOpen = editRunbook != null || editRoutine != null || editPolicy != null,
		locked = locked,
		overlayOpen = overlays.isNotEmpty(),
		booted = missingBoot == null,
		drawerOpen = shownDrawer.holdsBack(),
		offeredRoot = offeredRoot,
		offeredConversation = offeredConversation,
	)
	val layer = backLayer(nav, backFacts)
	BackHandler(enabled = layer != null) {
		when (layer) {
			BackLayer.EDITOR -> when {
				editPolicy != null -> editPolicy = null
				editRoutine != null -> editRoutine = null
				else -> editRunbook = null
			}
			BackLayer.OVERLAY -> closeOverlay()
			BackLayer.DRAWER -> shellScope.launch { shownDrawer.close() }
			null -> Unit
			else -> nav = nav.back(layer, backFacts, state.provisioned)
		}
	}

	when (screen) {
		ShellScreen.LOCK -> LockScreen(onUnlock = { activity?.let { a -> promptUnlock(a) { ok -> if (ok) unlocked = true } } })
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
				onClear = {
					// Wipe plugins and notifications after local wipe.
					pluginManager.host.accountWipeHandlers.forEachCaught(onError = ::logPluginThrow) { it.onWipe(context) }
					ServiceNotifications.cancelProvisioningNotifications(context)
					overlays = emptyList()
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
		ShellScreen.CONVERSATION -> {
			// Devcontainer names are fixed.
			val session = state.sessions().firstOrNull { it.name == openTeam }
			val kind = session?.kind
			// Rename only known loose sessions.
			val presence = when {
				session == null -> null
				session.presence.isOnline -> when {
						// Limit block outranks working.
					session.presence.limitBlocked == true -> "limit hit"
					state.needsLogin(session.name) -> "check terminal"
					state.working(session.name) -> "working..."
					else -> "live"
				}
				// Local wake displays immediately.
				session.presence.waking(System.currentTimeMillis()) -> "waking..."
				!session.presence.isLive && !session.presence.hasEnded ->
					if (state.working(session.name)) "waking..." else session.presence.word
				else -> session.presence.word
			}
				// Teardown after forget lands.
			val forgetTeardown = { forgotten: String ->
				pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) { it.onForget(context, forgotten) }
				SwitchboardService.cancelTeamNotification(context, forgotten)
				SwitchboardService.cancelScheduledSendFailedNotification(context, forgotten)
				nav = nav.forgot(forgotten)
			}
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
			val vaultPending by repo.vault.pending.collectAsState()
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
			val windowBoards by repo.windowOps.windows.collectAsState()
			val facts = ConversationFacts(
				team = team,
				openWindows = windowBoards.entries.firstOrNull { it.key.address == team }?.value?.size ?: 0,
				undoneTasks = if (boardOn) repo.boardOps.boardUndoneCountFor(team) else 0,
				pendingRequests = ViewScope.Session(team).requestsOf(vaultPending).size,
			)
			val marks = offered.map { conversationMark(it, facts) }
			SideDrawer(
				drawers = conversationDrawer,
				sheet = {
					DrawerHeader(tabLabelFor(state, team), localFieldOf(team), monospace = true)
					offered.forEachIndexed { index, view ->
						if (index > 0 && view.scoped != null && offered[index - 1].scoped == null) DrawerDivider()
						DrawerRow(view.title, iconOf(view), view == shown, marks[index]) {
							nav = nav.showView(view)
							shellScope.launch { conversationDrawer.close() }
						}
					}
				},
			) {
			ThreadScreen(
				team = openTeam!!,
				label = tabLabelFor(state, openTeam!!),
				presence = presence,
				tabs = state.openTabs,
				tabLabel = { tabLabelFor(state, it) },
				onReorderTabs = repo::reorderTabs,
				messages = state.threads[openTeam].orEmpty(),
					// Suppress retry banner during wake.
				error = state.error?.takeUnless { presence == "waking..." && it.endsWith("retrying") },
				rendererPool = rendererPool,
				canRename = kind == "loose",
				openNonce = nav.generation,
				boardStrip = boardStripFor,
				boardLiveLine = boardLiveLineFor,
				boardRevision = boardRevision,
				boardStripHeight = boardStripHeight,
				onBoardStripHeight = { boardStripHeight = it; repo.store.boardStripHeight = it },
				onOpenBoardEntry = { boardModal = it.entry.id },
				onMoveBoardEntry = shellActions.moveBoardEntry,
				vaultTile = vaultTileFor,
				onOpenVaultRequest = { vaultModal = VaultModal.Request(it) },
				revealAt = revealAt,
				onRevealed = { revealAt = null },
				unreadBoundary = repo::unreadBoundary,
				onGateway = { t -> nav = nav.arrive(t, Arrival.TAB, factsFor(t)) },
				onCloseTab = { t ->
						// Leave closing tab before renderer removal.
					if (t == openTeam) {
						val next = state.openTabs.firstOrNull { it != t }
						nav = if (next == null) nav.leave() else nav.arrive(next, Arrival.CLOSED_TAB, factsFor(next))
					}
					repo.closeTab(t)
				},
				onSessions = { nav = nav.leave() },
				composer = ComposerState(
					draft = state.drafts[openTeam!!] ?: Draft(),
					sendAwaitingWake = state.awaitingWake(openTeam!!),
					onSend = { text, uris -> repo.command { send(openTeam!!, text, uris) } },
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
					onSchedule = { text, uris, at -> repo.scheduled.scheduleSend(openTeam!!, text, uris, at) },
					onReschedule = { at -> repo.scheduled.rescheduleSend(openTeam!!, at) },
					onCancel = { repo.scheduled.cancelScheduledSendForEdit(openTeam!!) },
				),
				goal = GoalState(
					record = state.goals[openTeam!!],
					onArm = { g, text, uris -> repo.goals.armAndSend(openTeam!!, g, text, uris) },
					onCancel = { repo.goals.cancelGoal(openTeam!!) },
				),
				onRename = { name -> repo.command { rename(openTeam!!, name) } },
				onForget = {
					val forgotten = openTeam!!
					repo.sessions.forget(forgotten)
					forgetTeardown(forgotten)
				},
				// Use the same board forget gate.
				undoneTasks = if (boardOn) repo.boardOps.boardUndoneCountFor(openTeam!!) else 0,
				onForgetWithTasks = { cancelThem ->
					val forgotten = openTeam!!
					repo.boardOps.forgetWithBoardDisposition(forgotten, cancelThem) { forgetTeardown(forgotten) }
				},
				terminal = TerminalState(
					eligible = ConversationView.TERMINAL in offered,
						// Peek uses presence freshness.
					presence = session?.presence,
						// Presence supplies login status before online.
					needsLogin = session?.presence?.needsLogin == true,
					limitBlocked = session?.presence?.limitBlocked == true,
					limitDetail = session?.presence?.limitDetail,
					onWake = { repo.sessions.wakeSession(openTeam!!) },
					onRelaunch = { repo.sessions.relaunchSession(openTeam!!) },
					refreshMs = repo.sessions.terminalRefreshMs,
					onPeek = { hash -> repo.sessions.peekTerminal(openTeam!!, hash) },
					onSend = { text, key, submit -> repo.sessions.tmuxSend(openTeam!!, text, key, submit) },
					onResumeAfterLimit = { repo.sessions.resumeAfterLimit(openTeam!!) },
				),
				onFocusChange = repo::declareFocus,
				view = shown,
				onView = { nav = nav.showView(it) },
				drawerSide = drawerSide,
				drawerBadged = anyBadge(marks),
				onOpenDrawer = { shellScope.launch { conversationDrawer.open(drawerSide) } },
				body = { modifier ->
					val scoped = shown.scoped
					if (scoped == null) {
						com.atelier_nyaarium.switchboard.workspace.WorkspaceScreen(
							repo = repo,
							session = state.teams.firstOrNull { it.name == team },
							rosterLoaded = state.gateways.loaded,
							stack = nav.conversation?.files ?: listOf(WORKSPACE_ROOT),
							onPush = { nav = nav.pushFiles(it) },
							onPop = { nav = nav.popFiles() },
							modifier = modifier,
						)
					} else {
						androidx.compose.foundation.layout.Column(modifier) {
							ScopeRow(scoped, team) { nav = nav.wholeOf(scoped) }
							ScopedViewBody(
								view = scoped,
								scope = ViewScope.Session(team),
								repo = repo,
								state = state,
								actions = shellActions,
								modifier = Modifier.weight(1f),
							)
						}
					}
				},
			)
			}
		}
		ShellScreen.ROOT -> {
			val snackbarHostState = remember { SnackbarHostState() }
			// Transient failures use snackbar.
			LaunchedEffect(state.transientMessages) {
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
			val vaultOn = pluginManager.isActive("vault")
			LaunchedEffect(vaultOn) { if (!vaultOn) editPolicy = null }
			val vaultPending by repo.vault.pending.collectAsState()
			// Grants re-read on the vault's own tick.
			val vaultRevision by repo.vault.revision
			val vaultTiers = remember(vaultRevision, state.teams, vaultOn) {
				if (!vaultOn) emptyMap() else state.teams.associate { it.name to repo.vaultOps.grantTierFor(it.name) }
			}
			RootScreen(
				views = offeredRoot,
				shown = shownView(offeredRoot, nav.root),
				onView = { nav = nav.showRoot(it) },
				drawerSide = drawerSide,
				drawers = rootDrawer,
				domainId = state.domainId,
				vaultPending = if (vaultOn) vaultPending.size else 0,
				snackbarHostState = snackbarHostState,
				onRefresh = {
					repo.command { presence.refreshTeams() }
						// Refresh retries non-route columns.
					repo.boardOps.refreshBoard()
				},
				onSettings = { nav = nav.openSettings() },
				queueState = queueState,
				onQueue = { openQueueRequest.value = true },
			) { view, modifier ->
				val scoped = view.scoped
				if (scoped != null) {
					ScopedViewBody(
						view = scoped,
						scope = ViewScope.Everything,
						repo = repo,
						state = state,
						actions = shellActions,
						modifier = modifier,
						onBoardSaved = { nav = nav.showRoot(RootView.SESSIONS) },
					)
				} else {
					SessionsScreen(
						state = state,
						modifier = modifier,
						onRefresh = { repo.command { presence.refreshTeams() } },
						onManage = { openOverlay(Overlay.Manage) },
						onAddGateway = { openOverlay(Overlay.AddGateway) },
						onHostHelp = { openOverlay(Overlay.HostHelp) },
						onOpen = { team ->
							repo.openThread(team)?.let { nav = nav.arrive(it, Arrival.OUTSIDE, factsFor(it)) }
						},
						onRename = { team, name -> repo.command { rename(team, name) } },
						onForget = { team ->
							pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) {
								it.onForget(context, team)
							}
							repo.sessions.forget(team)
							SwitchboardService.cancelTeamNotification(context, team)
							SwitchboardService.cancelScheduledSendFailedNotification(context, team)
						},
						// Spawn stays on board; next poll reveals session.
						onSpawn = { target, label, workdir -> repo.command { sessions.spawnSession(target, label, workdir) } },
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
						onForgetWithTasks = { team, cancelThem ->
								// Clean up plugins after forget lands.
							repo.boardOps.forgetWithBoardDisposition(team, cancelThem) {
								pluginManager.host.threadForgetHandlers.forEachCaught(onError = ::logPluginThrow) {
									it.onForget(context, team)
								}
								SwitchboardService.cancelTeamNotification(context, team)
								SwitchboardService.cancelScheduledSendFailedNotification(context, team)
							}
						},
					)
				}
			}
		}
	}

	QueueOverlay(repo, openQueueRequest, locked, revealAtState, openTeamRequest)
	AttachmentViewerOverlay(viewerState, rendererPool)
	LinkMenuDialog(linkMenuState, linkMenuNoteState)
	// Board dialog replaces current screen.
	boardModal?.let { entryId ->
		BoardEntryDialog(state, repo, entryId) { boardModal = null }
	}
	when (val modal = vaultModal) {
		is VaultModal.Entry ->
			com.atelier_nyaarium.switchboard.vault.VaultEntryDialog(repo, state, modal.id) { vaultModal = null }
		is VaultModal.Request ->
			com.atelier_nyaarium.switchboard.vault.VaultRequestSheet(repo, state, modal.id) { vaultModal = null }
		null -> {}
	}
	fireRunbook?.let { fire ->
		com.atelier_nyaarium.switchboard.runbooks.RunbookFireSheet(repo, state, fire.gatewayId, fire.id, fire.into) { fireRunbook = null }
	}
	editRunbook?.let { (gatewayId, opened) ->
		val id = opened.ifEmpty { null }
		com.atelier_nyaarium.switchboard.runbooks.RunbookEditor(repo, gatewayId, id) { editRunbook = null }
	}
	editRoutine?.let { (gatewayId, opened) ->
		val id = opened.ifEmpty { null }
		com.atelier_nyaarium.switchboard.routines.RoutineEditor(repo, state, gatewayId, id) { editRoutine = null }
	}
	editPolicy?.let { (gatewayId, opened) ->
		val id = opened.ifEmpty { null }
		com.atelier_nyaarium.switchboard.policies.PolicyEditor(repo, state, gatewayId, id) { editPolicy = null }
	}
}


/** Log and skip plugin claim errors. */
internal fun logPluginThrow(message: String, err: Throwable) {
	DebugLog.log("Plugins", "$message: $err")
}
