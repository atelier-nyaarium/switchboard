package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.atelier_nyaarium.switchboard.assistantRoleHeld
import com.atelier_nyaarium.switchboard.assistantScreenDataEnabled
import com.atelier_nyaarium.switchboard.openAssistantPicker
import com.atelier_nyaarium.switchboard.assistantSections
import com.atelier_nyaarium.switchboard.canRetry
import com.atelier_nyaarium.switchboard.LocationAction
import com.atelier_nyaarium.switchboard.folderOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.homeRefusal
import com.atelier_nyaarium.switchboard.locationAction
import com.atelier_nyaarium.switchboard.moveErrorText
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.relativeTime
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.routines.SecretNeeded
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.rulesCountText
import com.atelier_nyaarium.switchboard.unexpectedLines
import com.atelier_nyaarium.switchboard.vault.grantableOn
import com.atelier_nyaarium.switchboard.watcherActions
import com.atelier_nyaarium.switchboard.watcherHealth
import com.atelier_nyaarium.switchboard.watcherOn
import com.atelier_nyaarium.switchboard.watcherTroubled

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
internal fun AssistantPageScaffold(title: String, onBack: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(title) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
				},
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
	val required = remember(tick) { requiredFacts(context) }
	var removing by remember { mutableStateOf(false) }
	val settings = settingsRunner(repo)
	// Refresh on open.
	LaunchedEffect(home) { home?.let { gatewayId -> repo.command { assistantOps.refresh(gatewayId) } } }

	AssistantPageScaffold("Assistant settings", onBack) {
		(work.said ?: state.homeFailure?.let(::moveErrorText))?.let {
			Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
		for (section in assistantSections(home, homeState)) {
			when (section) {
				AssistantSection.LOCATION ->
					SettingsRow("Session data location", locationLines(home, homeState?.workdir)) { onPage(AssistantPage.Location) }
				AssistantSection.FEATURES ->
					SettingsRow("Features", featureLines(required.assistantOn, required.screenData, features)) { onPage(AssistantPage.Features) }
				AssistantSection.SAFETY ->
					SettingsRow("Safety", safetyLines(homeState?.approveEverySend)) { onPage(AssistantPage.Safety) }
				AssistantSection.WATCHERS ->
					SettingsRow("Watchers", watcherLines(homeState?.watchers.orEmpty())) { onPage(AssistantPage.Watchers) }
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

@Composable
private fun AssistantWatchersPage(state: ChatState, home: String?, onWatcher: (String, String) -> Unit, onBack: () -> Unit) {
	val holding = home?.let { state.gateways.assistantOn(it) }
	var showDisabled by rememberSaveable { mutableStateOf(false) }
	AssistantPageScaffold("Watchers", onBack) {
		if (home != null && holding != null) {
			val (on, off) = holding.watchers.partition(::watcherOn)
			for (watcher in on) {
				WatcherRow(watcher.label, watcherHealth(watcher, ::agoText), watcherTroubled(watcher)) { onWatcher(home, watcher.id) }
			}
			if (off.isNotEmpty()) {
				FoldRow("Disabled", showDisabled) { showDisabled = !showDisabled }
				if (showDisabled) {
					for (watcher in off) WatcherRow(watcher.label, null, false) { onWatcher(home, watcher.id) }
				}
			}
		}
	}
}

@Composable
private fun AssistantFeaturesPage(repo: ChatRepository, onBack: () -> Unit) {
	val context = androidx.compose.ui.platform.LocalContext.current
	val toggles = repo.phoneCapabilityOps.features
	val wanted by toggles.wanted.collectAsState()
	var tick by remember { mutableStateOf(0) }
	// Grants change while away.
	androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
		tick++
		onPauseOrDispose {}
	}
	var asking by remember { mutableStateOf<String?>(null) }
	var denied by remember { mutableStateOf(setOf<String>()) }
	val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		if (!granted) asking?.let { denied = denied + it }
		asking = null
		tick++
	}
	val views = remember(tick, wanted) {
		featureViews(featureRows(PhoneCapabilities.bindings.values), wanted, repo.phoneCapabilityOps::grants)
	}
	val required = remember(tick) { requiredFacts(context) }
	val open = { need: String ->
		val manifest = manifestPermissionOf(need)
		val rationale = manifest != null && (context as? android.app.Activity)?.shouldShowRequestPermissionRationale(manifest) == true
		when (permissionDoor(need, askable(need, denied, rationale))) {
			PermissionDoor.REQUEST -> manifest?.let {
				asking = need
				request.launch(it)
			}
			PermissionDoor.APP_SETTINGS -> openAppSettings(context)
		}
	}
	AssistantPageScaffold("Features", onBack) {
		Text("Required", style = MaterialTheme.typography.labelLarge)
		for (row in requiredRows(required)) {
			RequiredRowView(row) {
				when (row.door) {
					RequiredDoor.PICKER -> openAssistantPicker(context)
					RequiredDoor.NOTIFICATIONS -> open("notifications")
				}
			}
		}
		for ((group, inGroup) in views.groupBy { it.row.group }) {
			HorizontalDivider()
			Text(group, style = MaterialTheme.typography.labelLarge)
			for (view in inGroup) {
				FeatureRowView(
					view,
					featureRowModel(view),
					onToggle = { on -> toggles.setWanted(view.row.key, toggledWanted(view, on)) },
					onGear = { gear ->
						when (gear) {
							is GearTarget.Need -> open(gear.need)
							GearTarget.AppSettings -> openAppSettings(context)
						}
					},
				)
			}
		}
	}
}

@Composable
private fun RequiredRowView(row: RequiredRow, onGear: () -> Unit) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Column(Modifier.weight(1f)) {
			Text(row.label, style = MaterialTheme.typography.bodyLarge)
			Text(
				if (row.on) "On" else row.offWord,
				style = MaterialTheme.typography.bodySmall,
				color = if (row.on) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
			)
		}
		IconButton(onClick = hapticClick(onGear)) { Icon(Icons.Default.Settings, contentDescription = "Open setting") }
	}
}

@Composable
private fun FeatureRowView(view: FeatureView, model: FeatureRowModel, onToggle: (Boolean) -> Unit, onGear: (GearTarget) -> Unit) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(if (view.row.guarded) "${view.row.label} · Asks first" else view.row.label, style = MaterialTheme.typography.bodyLarge)
			needsLine(view)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		Switch(checked = view.wanted, onCheckedChange = onToggle, enabled = model.switchEnabled)
		val gear = model.gear
		if (gear == null) {
			Spacer(Modifier.size(48.dp))
		} else {
			IconButton(onClick = hapticClick { onGear(gear) }) { Icon(Icons.Default.Settings, contentDescription = "Open permission") }
		}
	}
}

private fun requiredFacts(context: android.content.Context) = RequiredFacts(
	roleHeld = assistantRoleHeld(context),
	sessionAdopted = assistantSessionAdopted(context),
	screenData = assistantScreenDataEnabled(context),
	notifications = grantedOn(context, "notifications"),
)

private fun grantedOn(context: android.content.Context, need: String): Boolean {
	val manifest = manifestPermissionOf(need) ?: return false
	return runIsolated { context.checkSelfPermission(manifest) == android.content.pm.PackageManager.PERMISSION_GRANTED }
		.getOrDefault(false)
}

private fun openAppSettings(context: android.content.Context) {
	runIsolated {
		context.startActivity(
			android.content.Intent(
				android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
				android.net.Uri.fromParts("package", context.packageName, null),
			).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
		)
	}
}

/** Red health when troubled. */
@Composable
private fun WatcherRow(label: String, health: String?, troubled: Boolean, onOpen: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(label, style = MaterialTheme.typography.bodyLarge)
			health?.let {
				Text(
					it,
					style = MaterialTheme.typography.bodySmall,
					color = if (troubled) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
		Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
	}
}

@Composable
private fun FoldRow(label: String, open: Boolean, onToggle: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Icon(
			if (open) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight,
			contentDescription = if (open) "Collapse" else "Expand",
			modifier = Modifier.size(18.dp),
		)
		Text(label, style = MaterialTheme.typography.labelLarge)
	}
}

@Composable
private fun AssistantWatcherPage(
	repo: ChatRepository,
	gatewayId: String,
	watcher: AssistantWatcher,
	onRules: () -> Unit,
	onBack: () -> Unit,
) {
	val key = WorkKey.Watcher(gatewayId, watcher.id)
	val works by repo.assistantOps.work.collectAsState()
	val work = works[key] ?: PageWork()
	val busy = work.busy
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val offered = remember(entries, gatewayId) { entries.grantableOn(gatewayId) }
	var granting by remember { mutableStateOf(false) }
	val run = { op: suspend AssistantOps.() -> String? -> repo.command { assistantOps.runWork(key, op) } }
	val on = watcherOn(watcher)

	AssistantPageScaffold(watcher.label, onBack) {
		work.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
			Text("Enabled", modifier = Modifier.weight(1f))
			Switch(
				checked = on,
				onCheckedChange = { enabled -> run { answerText(setEnabled(gatewayId, watcher.id, enabled)) } },
				enabled = !busy,
			)
		}
		if (on) {
			Text(
				watcherHealth(watcher, ::agoText),
				style = MaterialTheme.typography.bodySmall,
				color = if (watcherTroubled(watcher)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		watcher.secret?.let { needs ->
			HorizontalDivider()
			Text("Secret", style = MaterialTheme.typography.labelLarge)
			SecretNeeded(needs)
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(grantedLine(watcher.grants, entries), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
				OutlinedButton(onClick = hapticClick { granting = true }, enabled = !busy) { Text("Assign secret") }
			}
		}
		val may = watcherActions(watcher)
		if (may.isNotEmpty()) {
			HorizontalDivider()
			Text("The assistant may", style = MaterialTheme.typography.labelLarge)
			for (action in may) {
				Column {
					Text(action.label, style = MaterialTheme.typography.bodyMedium)
					Text(
						action.description,
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
		}
		rulesOf(watcher)?.let { rules ->
			HorizontalDivider()
			Row(
				Modifier.fillMaxWidth().clickable(enabled = !busy, onClick = hapticClick(onRules)).padding(vertical = 8.dp),
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(8.dp),
			) {
				Text("Rules", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
				Text(
					rulesCountText(rules.held.rules.size, rules.invalid.size),
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
			}
		}
		val unexpected = unexpectedLines(watcher)
		if (unexpected.isNotEmpty()) {
			Text("Seen outside its lists", style = MaterialTheme.typography.labelLarge)
			for (line in unexpected) {
				Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		if (canRetry(watcher)) {
			TextButton(onClick = hapticClick { run { answerText(retry(gatewayId, watcher)) } }, enabled = !busy) { Text("Retry") }
		}
	}

	if (granting) {
		GrantSecretsSheet(
			entries = offered,
			granted = watcher.grants,
			onDone = { picks ->
				granting = false
				run { answerText(setGrants(gatewayId, watcher.id, picks)) }
			},
			onDismiss = { granting = false },
			needs = watcher.secret,
		)
	}
}

private fun agoText(at: Long): String = relativeTime(at).let { if (it == "now") "just now" else "$it ago" }
