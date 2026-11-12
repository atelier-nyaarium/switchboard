package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceSession
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import kotlinx.coroutines.delay


internal fun sessionOrder(state: ChatState): Comparator<Team> =
	compareByDescending<Team> { it.isLive }
		.thenByDescending { state.lastActivity(it.name) ?: 0L }
		.thenBy { state.label(it.name) }

// Peer rows render in the linked-friends section.
internal fun localSessions(sessions: List<Team>, adminDomainId: String): List<Team> =
	ordinarySessions(sessions.filter { it.domainId == adminDomainId })

// Peer presence is untrusted and may duplicate keys.
internal fun dedupedFriendSessions(sessions: List<CrossDomainPresenceSession>): List<CrossDomainPresenceSession> =
	sessions.distinctBy { it.gatewayId to it.team }

// Gateway IDs are unique only within a Domain.
internal data class GatewayGroupKey(val domainId: String, val gatewayId: String)

/** Every roster Gateway gets a section; own Domain first, then by id. */
internal fun groupByGateway(
	local: List<Team>,
	registry: GatewayRegistry,
	adminDomainId: String,
): List<Pair<GatewayGroupKey, List<Team>>> {
	val grouped = local.groupBy { GatewayGroupKey(it.domainId, it.gatewayId) }
	val empties =
		registry.ids()
			.map { GatewayGroupKey(adminDomainId, it) }
			.filterNot { it in grouped }
			.associateWith { emptyList<Team>() }
	return (grouped + empties).toList().sortedWith(
		compareBy({ (key, _) -> key.domainId != adminDomainId }, { (key, _) -> key.domainId }, { (key, _) -> key.gatewayId }),
	)
}

/** Every offered project qualifies on this Gateway; one that cannot is not offered. */
internal data class CreateDialogTarget(
	val domainId: String,
	val gatewayId: String,
	val projects: List<String>,
	/** Opened from that project's own header. */
	val picked: String? = null,
) {
	fun targetFor(project: String): String = SpawnPoint.of(domainId, gatewayId, project).canonical

	companion object {
		fun of(domainId: String, gatewayId: String, candidates: List<String>, picked: String? = null): CreateDialogTarget =
			CreateDialogTarget(
				domainId,
				gatewayId,
				candidates.filter { runIsolated { SpawnPoint.of(domainId, gatewayId, it) }.isSuccess },
				picked,
			)
	}
}

/** Header order after `host`: projects with a spawn point row, then reported containers, then the rest. */
internal fun containerProjects(spawnRows: List<String>, reported: List<String>, orphans: Set<String>): List<String> =
	(spawnRows + reported.sorted() + orphans.sorted()).distinct()


@Composable
fun SessionsScreen(
	state: ChatState,
	onRefresh: () -> Unit,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onOpen: (String) -> Unit,
	onRename: (String, String) -> Unit,
	onMarkRead: (String) -> Unit,
	onForget: (String) -> Unit,
	onSpawn: (String, String, String?, SessionHarness) -> Unit,
	onStartContainer: (String) -> Unit = {},
	onStopContainer: (String) -> Unit = {},
	onListDirs: suspend (String, String, String) -> DirListing = { _, _, _ -> DirListing(emptyList()) },
	onVerifyEnroll: (() -> Unit)? = null,
	onRouterEndpoint: (() -> Unit)? = null,
	boardLine: (Team) -> BoardLiveLine? = { null },
	boardBranch: (Team) -> com.atelier_nyaarium.switchboard.board.CardBranch? = { null },
	undoneFor: (Team) -> Int = { 0 },
	onForgetWithTasks: (String, Boolean) -> Unit = { _, _ -> },
	vaultTier: (Team) -> String? = { null },
	modifier: Modifier = Modifier,
) {
	var actionTeam by remember { mutableStateOf<Team?>(null) }
	var createDialogFor by remember { mutableStateOf<CreateDialogTarget?>(null) }
	var renameTeam by remember { mutableStateOf<Team?>(null) }
	var forgetTeam by remember { mutableStateOf<Team?>(null) }
	var stopAsking by remember { mutableStateOf<StopAsk?>(null) }
	val collapsedGateways = rememberSaveable { mutableStateOf(setOf<String>()) }

	stopAsking?.let { ask ->
		ConfirmDialog(
			title = "Stop anyway?",
			body = (listOf("These sessions are still active:") + ask.names).joinToString("\n"),
			confirmText = "Stop",
			onConfirm = {
				onStopContainer(ask.target)
				stopAsking = null
			},
			onDismiss = { stopAsking = null },
		)
	}

	actionTeam?.let { team ->
		SessionActionsDialog(
			label = state.label(team.name),
			canRename = team.kind != "devcontainer",
			onRename = {
				actionTeam = null
				renameTeam = team
			},
			onMarkRead = {
				actionTeam = null
				onMarkRead(team.name)
			},
			onForget = {
				actionTeam = null
				forgetTeam = team
			},
			onDismiss = { actionTeam = null },
		)
	}
	renameTeam?.let { team ->
		RenameDialog(
			team = team.shortName,
			current = state.label(team.name),
			onSave = {
				onRename(team.name, it)
				renameTeam = null
			},
			onDismiss = { renameTeam = null },
		)
	}
	forgetTeam?.let { team ->
		val undone = undoneFor(team)
		if (undone > 0) {
			BoardForgetDialog(
				label = state.label(team.name),
				undone = undone,
				onCancelTasks = {
					onForgetWithTasks(team.name, true)
					forgetTeam = null
				},
				onUnassign = {
					onForgetWithTasks(team.name, false)
					forgetTeam = null
				},
				onDismiss = { forgetTeam = null },
			)
		} else {
			ConfirmDialog(
				title = "Forget ${state.label(team.name)}?",
				body = "Drops this thread, its label, and unread state from this device.",
				confirmText = "Forget",
				onConfirm = {
					onForget(team.name)
					forgetTeam = null
				},
				onDismiss = { forgetTeam = null },
			)
		}
	}
	createDialogFor?.let { opened ->
		CreateSessionDialog(
			gateway = opened.gatewayId,
			choices = spawnChoices(state, opened.gatewayId).filter { it.spawn in opened.projects },
			pendingSpawns = state.pendingSpawns,
			targetOf = opened::targetFor,
				onListDirs = { path, spawn -> onListDirs(path, opened.targetFor(spawn), spawn) },
			rememberedProject = state.lastProjectByGateway[opened.gatewayId],
			openedOn = opened.picked,
			harnessesOn = { project -> state.gateways.harnessesOn(opened.gatewayId, project) },
			onSpawn = { target, session, workdir, harness ->
				onSpawn(target, session, workdir, harness)
				createDialogFor = null
			},
			onDismiss = { createDialogFor = null },
		)
	}

	Column(modifier.fillMaxSize()) {
		val sessions = state.sessions()
			val adminDomainId = state.domainId.orEmpty()
			val local = localSessions(sessions, adminDomainId)
			// Linked peers remain visible before local Domain discovery.
			val linkedDomains =
				CrossDomainLink.mergeLinkedDomains(state.teams, state.linkedPeerOwners, adminDomainId, state.friendLabels())
			val byGateway = groupByGateway(local, state.gateways, adminDomainId)
			val onboarding = (byGateway.isEmpty() && linkedDomains.isEmpty()) ||
				(local.isEmpty() && linkedDomains.isEmpty() && emptyBoardHasCause(state))
			if (!onboarding) HealthHeader(state)
			if (onboarding) {
				EmptyBoard(
					state,
					onManage,
					onAddGateway,
					onHostHelp,
					onRefresh,
					onVerifyEnroll = onVerifyEnroll,
					onRouterEndpoint = onRouterEndpoint,
				)
			} else {
				val pulsePhase = rememberSessionsPulsePhase()
				val order = sessionOrder(state)
				var freshnessNow by remember { mutableStateOf(System.currentTimeMillis()) }
				LaunchedEffect(linkedDomains.isNotEmpty(), state.foreground) {
					if (linkedDomains.isEmpty() || !state.foreground) return@LaunchedEffect
					while (true) {
						// Refresh immediately when foreground monitoring starts.
						freshnessNow = System.currentTimeMillis()
						delay(30_000)
					}
				}
				LazyColumn(
					Modifier.fillMaxSize(),
					contentPadding = PaddingValues(12.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp),
				) {
					for ((key, group) in byGateway) {
						val composite = "${key.domainId}/${key.gatewayId}"
						val collapsed = composite in collapsedGateways.value
						val isPeer = key.domainId.isNotEmpty() && adminDomainId.isNotEmpty() && key.domainId != adminDomainId
						val headerName = if (isPeer) composite else key.gatewayId
						val showCreate = !isPeer && state.gateways.offersSpawn(key.gatewayId)
						fun localName(t: Team) = t.shortName
						val spawnPoints = group.filter { it.kind == "devcontainer" }.sortedWith(order)
						item(key = "sw:$composite") {
							GatewayHeader(
								name = headerName,
								online = group.any { it.isLive },
								collapsed = collapsed,
								onToggle = {
								val open = collapsedGateways.value
								collapsedGateways.value = if (collapsed) open - composite else open + composite
							},
								showCreate = showCreate,
								onCreate = {
									createDialogFor = CreateDialogTarget.of(
										key.domainId,
										key.gatewayId,
										// Host shells, then every devcontainer, stopped or not.
										spawnChoices(state, key.gatewayId).map { it.spawn },
									)
								},
								standing = if (isPeer) null else state.gateways.standing(key.gatewayId),
								stale = !isPeer && state.gateways.provenance == RegistryProvenance.Cached,
							)
						}
						if (!collapsed) {
							val composites = group.filter { it.kind != "devcontainer" && isComposite(localName(it)) }
							val flatLoose =
								group.filter { it.kind != "devcontainer" && !isComposite(localName(it)) }.sortedWith(order)
							val byProject = composites.groupBy { parseSessionName(localName(it)).project }
							val spawnKeys = spawnPoints.map { localName(it) }.toSet()

							fun renderProject(projectKey: String, always: Boolean = false, header: @Composable () -> Unit) {
								val sessions = byProject[projectKey].orEmpty().sortedWith(order)
								if (sessions.isEmpty() && !always) return
								// Spawn names are unique only within a Gateway.
								item(key = "spawn:$composite/$projectKey") { header() }
								items(sessions, key = { "team:${it.name}" }) { team ->
									SessionCard(
										state = state,
										team = team,
										nested = true,
										pulsePhase = pulsePhase,
										boardLine = boardLine(team),
									boardBranch = boardBranch(team),
										vaultTier = vaultTier(team),
										onClick = hapticClick { onOpen(team.name) },
										onLongPress = { actionTeam = team },
									)
								}
							}

							if (showCreate) {
								renderProject("host") {
									SpawnPointHeader(project = "host", online = byProject["host"].orEmpty().any { it.isLive })
								}
							}
							val reported = if (isPeer) emptyList() else state.gateways.containersOn(key.gatewayId)
							val orphanProjects = byProject.keys - spawnKeys - reported.map { it.project }.toSet() -
								(if (showCreate) setOf("host") else emptySet())
							val headed = containerProjects(spawnPoints.map(::localName), reported.map { it.project }, orphanProjects)
							for (proj in headed) {
								if (showCreate && proj == "host") continue
								val container = reported.find { it.project == proj }
								if (container == null) {
									renderProject(proj) {
										SpawnPointHeader(project = proj, online = proj in spawnKeys && byProject[proj].orEmpty().any { it.isLive })
									}
									continue
								}
								val target = SpawnPoint.of(key.domainId, key.gatewayId, proj).canonical
								renderProject(proj, always = true) {
									ContainerHeader(
										project = proj,
										failure = container.failure,
										buttons = containerButtons(container, reachable = showCreate, inFlight = target in state.containerOpsInFlight),
										onStart = { onStartContainer(target) },
										onStop = {
											val ask = stopAsk(target, sessionsIn(group, key.gatewayId, proj)) { state.label(it) }
											if (ask == null) onStopContainer(target) else stopAsking = ask
										},
										onCreate = {
											createDialogFor = CreateDialogTarget.of(key.domainId, key.gatewayId, listOf(proj), picked = proj)
										},
									)
								}
							}
							items(flatLoose, key = { "team:${it.name}" }) { team ->
								SessionCard(
									state = state,
									team = team,
									pulsePhase = pulsePhase,
									boardLine = boardLine(team),
									boardBranch = boardBranch(team),
									vaultTier = vaultTier(team),
									onClick = hapticClick { onOpen(team.name) },
									onLongPress = { actionTeam = team },
								)
							}
						}
					}
					if (linkedDomains.isNotEmpty()) {
						item(key = "linked-friends-label") { SectionLabel("Linked friends") }
						for (friend in linkedDomains) {
							val friendKey = "friend:${friend.domainId}"
							val collapsed = friendKey in collapsedGateways.value
							val entry = state.crossDomainPeerSessions[friend.domainId]
							val freshness = crossDomainFreshness(entry?.lastRefreshedAt, freshnessNow)
							val friendSessions = dedupedFriendSessions(entry?.sessions.orEmpty())
							item(key = "sw:$friendKey") {
								LinkedFriendHeader(
									name = friend.displayName ?: friend.domainId,
									freshness = freshness,
									collapsed = collapsed,
									onToggle = {
										val open = collapsedGateways.value
										collapsedGateways.value = if (collapsed) open - friendKey else open + friendKey
									},
								)
							}
							if (!collapsed) {
								if (friendSessions.isEmpty()) {
									item(key = "empty:$friendKey") {
										Text(
											"No shared sessions",
											style = MaterialTheme.typography.bodySmall,
											color = MaterialTheme.colorScheme.onSurfaceVariant,
											modifier = Modifier.padding(start = 20.dp, top = 4.dp, bottom = 8.dp),
										)
									}
								} else {
									items(
										friendSessions,
										key = { "friend-session:${friend.domainId}:${it.gatewayId}:${it.team}" },
									) { session ->
										LinkedFriendSessionRow(session)
									}
								}
							}
						}
					}
				}
			}
		}
}
