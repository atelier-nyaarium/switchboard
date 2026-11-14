package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ASSISTANT_SPAWN
import com.atelier_nyaarium.switchboard.AssistantOps
import com.atelier_nyaarium.switchboard.AssistantPage
import com.atelier_nyaarium.switchboard.AssistantRoot
import com.atelier_nyaarium.switchboard.AssistantSection
import com.atelier_nyaarium.switchboard.AssistantWord
import com.atelier_nyaarium.switchboard.PageWork
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.DirListing
import com.atelier_nyaarium.switchboard.DirectoryField
import com.atelier_nyaarium.switchboard.PhoneCapabilities
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.assistantSections
import com.atelier_nyaarium.switchboard.LocationAction
import com.atelier_nyaarium.switchboard.folderOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.homeRefusal
import com.atelier_nyaarium.switchboard.locationAction
import com.atelier_nyaarium.switchboard.moveErrorText
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.runIsolated

private const val DEFAULT_FOLDER = "~/"

/** Root without a conversation; the shell enters Placed. */
@Composable
internal fun AssistantRootScreen(
	root: AssistantRoot,
	onSettings: () -> Unit,
	modifier: Modifier = Modifier,
) {
	val body = MaterialTheme.typography.bodyLarge
	Column(modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
		when (root) {
			AssistantRoot.Loading, is AssistantRoot.Placed -> {}
			AssistantRoot.RouterUnreachable -> Text("Could not reach the Federation Router.", style = body)
			AssistantRoot.SetUp -> {
				Text("Visit Assistant Settings to set up.", style = body)
				Button(onClick = hapticClick(onSettings)) { Text("Settings") }
			}
			is AssistantRoot.Moving -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
				CircularProgressIndicator()
				Text(gatewayLine("Moving the assistant to ", root.gatewayId, "…"), style = body)
			}
			is AssistantRoot.Failed -> {
				Text(moveErrorText(root.reason), style = body)
				Button(onClick = hapticClick(onSettings)) { Text("Settings") }
			}
			is AssistantRoot.HomeUnreachable -> Text(gatewayLine("Assistant on ", root.gatewayId, " could not be reached."), style = body)
		}
	}
}

private fun gatewayLine(before: String, gatewayId: String, after: String) = buildAnnotatedString {
	append(before)
	withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(gatewayId) }
	append(after)
}

@Composable
internal fun AssistantPageHost(
	repo: ChatRepository,
	state: ChatState,
	page: AssistantPage,
	home: String?,
	onListDirs: suspend (String, String, String) -> DirListing,
	onPage: (AssistantPage) -> Unit,
	onBack: () -> Unit,
) {
	when (page) {
		AssistantPage.Settings -> AssistantSettingsIndex(repo, state, home, onPage, onBack)
		AssistantPage.Location -> AssistantLocationPage(repo, state, home, onListDirs, onBack)
		AssistantPage.Features -> AssistantFeaturesPage(repo, onBack)
		AssistantPage.Safety -> AssistantSafetyPage(repo, state, home, onBack)
		AssistantPage.Watchers ->
			AssistantWatchersPage(state, home, onWatcher = { g, w -> onPage(AssistantPage.Watcher(g, w)) }, onBack)
		AssistantPage.Integrations ->
			AssistantIntegrationsPage(
				repo,
				state,
				home,
				onAdd = { onPage(AssistantPage.Add) },
				onDevice = { g, d -> onPage(AssistantPage.Device(g, d)) },
				onService = { g, s -> onPage(AssistantPage.Entry(g, s)) },
				onBack,
			)
		AssistantPage.Add ->
			if (home == null) {
				AssistantPageScaffold("Add", onBack) { Text(PLACE_FIRST, style = MaterialTheme.typography.bodyLarge) }
			} else {
				IntegrationAddPage(state, home, onEntry = { g, id -> onPage(AssistantPage.Entry(g, id)) }, onBack)
			}
		is AssistantPage.Entry ->
			IntegrationEntryPage(
				repo,
				state,
				page.gatewayId,
				page.integrationId,
				onDevice = { g, d -> onPage(AssistantPage.Device(g, d)) },
				onSetup = { onPage(AssistantPage.Setup(page.gatewayId, page.integrationId)) },
				onAdded = { onPage(AssistantPage.Integrations) },
				onBack,
			)
		is AssistantPage.Setup ->
			PlugSetupPage(repo, page.gatewayId, onDevice = { onPage(AssistantPage.Device(page.gatewayId, it)) }, onBack)
		is AssistantPage.Device -> AssistantDevicePage(repo, page.gatewayId, page.deviceId, onBack)
		is AssistantPage.Watcher -> {
			val watcher = watcherIn(state.gateways.assistantOn(page.gatewayId), page.watcherId)
			if (watcher == null) {
				UnreadPage("Watcher", repo, state, page.gatewayId, onBack)
			} else {
				AssistantWatcherPage(repo, page.gatewayId, watcher, { onPage(AssistantPage.Rules(page.gatewayId, page.watcherId)) }, onBack)
			}
		}
		is AssistantPage.Rules -> {
			val watcher = watcherIn(state.gateways.assistantOn(page.gatewayId), page.watcherId)
			if (watcher == null) {
				UnreadPage("Rules", repo, state, page.gatewayId, onBack)
			} else {
				WatcherRulesPage(repo, page.gatewayId, watcher, { onPage(AssistantPage.Editor(page.gatewayId, page.watcherId, it)) }, onBack)
			}
		}
		is AssistantPage.Editor -> {
			val watcher = watcherIn(state.gateways.assistantOn(page.gatewayId), page.watcherId)
			if (watcher == null) {
				UnreadPage("Rule", repo, state, page.gatewayId, onBack)
			} else {
				RuleEditorPage(repo, page.gatewayId, watcher, page.slot) { onPage(AssistantPage.Rules(page.gatewayId, page.watcherId)) }
			}
		}
	}
}

/** Refused: Retry; unanswered waits. */
@Composable
private fun UnreadPage(title: String, repo: ChatRepository, state: ChatState, gatewayId: String, onBack: () -> Unit) {
	AssistantPageScaffold(title, onBack) {
		if (state.gateways.entry(gatewayId)?.assistant is AssistantWord.Refused) {
			Text("$gatewayId could not be read.", style = MaterialTheme.typography.bodyLarge)
			OutlinedButton(onClick = hapticClick { repo.command { assistantOps.refresh(gatewayId) } }) { Text("Retry") }
		} else {
			CircularProgressIndicator()
		}
	}
}

private fun watcherIn(placed: ConsoleAssistantStateResult?, watcherId: String): AssistantWatcher? =
	placed?.watchers?.find { it.id == watcherId }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AssistantPageScaffold(
	title: String,
	onBack: () -> Unit,
	actions: @Composable RowScope.() -> Unit = {},
	content: @Composable ColumnScope.() -> Unit,
) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(title) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
				actions = actions,
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)
				.padding(bottom = 24.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
			content = content,
		)
	}
}

@Composable
private fun AssistantLocationPage(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onListDirs: suspend (String, String, String) -> DirListing,
	onBack: () -> Unit,
) {
	val ops = repo.assistantOps
	val works by ops.work.collectAsState()
	val work = works[WorkKey.Location] ?: PageWork()
	val busy = work.busy
	val gateways = state.gateways.ids()
	// Its answer, not proof of placement.
	val homeState = home?.let { state.gateways.assistantOn(it) }
	var target by rememberSaveable(home) { mutableStateOf(home ?: gateways.firstOrNull()) }
	val folderText = homeState?.workdir ?: DEFAULT_FOLDER
	// A late answer reseeds it.
	var folder by rememberSaveable(home, homeState?.workdir, stateSaver = TextFieldValue.Saver) {
		mutableStateOf(TextFieldValue(folderText, TextRange(folderText.length)))
	}
	// Leaving closes the dialog.
	var abandoning by remember { mutableStateOf<LocationAction.Move?>(null) }
	val settings = settingsRunner(repo, WorkKey.Location)

	AssistantPageScaffold("Session data location", onBack) {
		(work.said ?: state.homeFailure?.let(::moveErrorText))?.let {
			Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
					PickMenu(
						label = "Gateway",
						choices = gateways,
						picked = target,
						labelOf = { it },
						onPick = { target = it },
						trailingOf = { gatewayId ->
							when {
								gatewayId == home -> "now"
								!state.gateways.reachable(gatewayId) -> "offline"
								else -> null
							}
						},
					)
					val domainId = state.domainId
					val picked = target
					val action = locationAction(state.gateways, home, picked, folder.text, homeState?.workdir)
					if (picked != null && domainId != null) {
						val hostTarget = runIsolated { SpawnPoint.of(domainId, picked, ASSISTANT_SPAWN).canonical }.getOrNull()
						DirectoryField(
							value = folder,
							onValueChange = { folder = it },
							spawn = ASSISTANT_SPAWN,
							machine = hostTarget ?: picked,
							offline = action is LocationAction.Offline,
							onListDirs = { path, spawn ->
								if (hostTarget == null) DirListing(emptyList()) else onListDirs(path, hostTarget, spawn)
							},
						)
					}
					if (action is LocationAction.Offline) {
						Text(
							"${action.gatewayId} is offline.",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.error,
						)
					}
					homeRefusal(state)?.let { reason ->
						Text(
							moveErrorText(reason),
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.error,
						)
					}
					Row(
						verticalAlignment = Alignment.CenterVertically,
						horizontalArrangement = Arrangement.SpaceBetween,
						modifier = Modifier.fillMaxWidth(),
					) {
						Button(
							onClick = hapticClick {
								val pending = action as? LocationAction.Move ?: return@hapticClick
								if (pending.abandoning != null) {
									abandoning = pending
								} else {
									val workdir = folderOf(folder.text)
									// The failure shows from state.
									settings { moveAssistant(pending.target, workdir); null }
								}
							},
							enabled = !busy && action is LocationAction.Move,
						) { Text(if (home == null) "Set up here" else "Move here") }
					}
	}

	abandoning?.let { pending ->
		ConfirmDialog(
			title = "Move the assistant to ${pending.target}?",
			body = "${pending.abandoning} can't be reached. Moving now will abandon the assistant settings and notes.",
			confirmText = "Move",
			onConfirm = {
				abandoning = null
				val workdir = folderOf(folder.text)
				settings { moveAssistant(pending.target, workdir, pending.abandoning); null }
			},
			onDismiss = { abandoning = null },
		)
	}

}

private fun settingsRunner(repo: ChatRepository, key: WorkKey = WorkKey.Settings): (suspend AssistantOps.() -> String?) -> Unit = { op ->
	repo.command { assistantOps.runWork(key, op) }
}

@Composable
private fun AssistantSettingsIndex(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onPage: (AssistantPage) -> Unit,
	onBack: () -> Unit,
) {
	val works by repo.assistantOps.work.collectAsState()
	val work = works[WorkKey.Settings] ?: PageWork()
	val homeState = home?.let { state.gateways.assistantOn(it) }
	val context = androidx.compose.ui.platform.LocalContext.current
	val wanted by repo.phoneCapabilityOps.features.wanted.collectAsState()
	var tick by remember { mutableStateOf(0) }
	// Grants change while away.
	androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
		tick++
		onPauseOrDispose {}
	}
	val features = remember(tick, wanted) {
		featureViews(featureRows(PhoneCapabilities.bindings.values), wanted, repo.phoneCapabilityOps::grants)
	}
	val phoneSettings = remember(tick) { phoneSettingFacts(context) }
	var removing by remember { mutableStateOf(false) }
	val settings = settingsRunner(repo)
	val deviceViews by repo.deviceOps.views.collectAsState()
	val deviceReach = home?.let { gatewayId ->
		state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation }
	}
	LaunchedEffect(home, deviceReach) {
		home?.let { gatewayId ->
			repo.command { assistantOps.refresh(gatewayId) }
			repo.command { deviceOps.relist(gatewayId) }
		}
	}

	AssistantPageScaffold("Assistant settings", onBack) {
		(work.said ?: state.homeFailure?.let(::moveErrorText))?.let {
			Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
		for (section in assistantSections(home, homeState)) {
			when (section) {
				AssistantSection.LOCATION ->
					SettingsRow("Session data location", locationLines(home, homeState?.workdir)) { onPage(AssistantPage.Location) }
				AssistantSection.FEATURES ->
					SettingsRow("Features", featureLines(phoneSettings.assistantOn, phoneSettings.screenData, features)) { onPage(AssistantPage.Features) }
				AssistantSection.SAFETY ->
					SettingsRow("Safety", safetyLines(homeState?.approveEverySend)) { onPage(AssistantPage.Safety) }
				AssistantSection.WATCHERS ->
					SettingsRow("Watchers", watcherLines(homeState?.watchers.orEmpty())) { onPage(AssistantPage.Watchers) }
				AssistantSection.INTEGRATIONS ->
					SettingsRow("Integrations", integrationLines(home, home?.let { deviceViews[it]?.list }, homeState?.integrations)) {
						onPage(AssistantPage.Integrations)
					}
				AssistantSection.REMOVE -> SettingsRow("Remove assistant", SettingsLines(line = REMOVE_LINE)) { removing = true }
			}
		}
	}

	if (removing) {
		ConfirmDialog(
			title = "Remove assistant",
			body = REMOVE_LINE,
			confirmText = "Remove",
			onConfirm = {
				removing = false
				settings { removeAssistant(); null }
			},
			onDismiss = { removing = false },
		)
	}
}

@Composable
private fun SettingsRow(title: String, lines: SettingsLines, onOpen: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(title, style = MaterialTheme.typography.bodyLarge)
			lines.warning?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
			lines.line?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
	}
}

@Composable
private fun AssistantSafetyPage(repo: ChatRepository, state: ChatState, home: String?, onBack: () -> Unit) {
	val works by repo.assistantOps.work.collectAsState()
	val work = works[WorkKey.Safety] ?: PageWork()
	val busy = work.busy
	val approveEverySend = home?.let { state.gateways.assistantOn(it) }?.approveEverySend
	val settings = settingsRunner(repo, WorkKey.Safety)
	AssistantPageScaffold("Safety", onBack) {
		work.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		if (home != null && approveEverySend != null) {
			Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
				Text("Approve every send", modifier = Modifier.weight(1f))
				Switch(
					checked = approveEverySend,
					onCheckedChange = { enabled -> settings { answerText(setSafety(home, enabled)) } },
					enabled = !busy,
				)
			}
		}
	}
}

