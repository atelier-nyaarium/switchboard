package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
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
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.assistantSections
import com.atelier_nyaarium.switchboard.canRetry
import com.atelier_nyaarium.switchboard.folderOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.movedText
import com.atelier_nyaarium.switchboard.placementMoves
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

private const val ASSISTANT_SPAWN = "host"
private const val DEFAULT_FOLDER = "~/"

/** The Assistant root with no conversation. */
@Composable
internal fun AssistantRootScreen(
	root: AssistantRoot,
	onConfigure: () -> Unit,
	onRetry: () -> Unit,
	modifier: Modifier = Modifier,
) {
	Column(modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
		when (root) {
			AssistantRoot.Unplaced -> {
				Text("Set a Gateway and directory where the assistant session lives.", style = MaterialTheme.typography.bodyLarge)
				Button(onClick = hapticClick(onConfigure)) { Text("Configure") }
			}
			AssistantRoot.Loading, is AssistantRoot.Placed -> CircularProgressIndicator()
			is AssistantRoot.Unavailable -> {
				Text("A Gateway that may hold the assistant could not be read.", style = MaterialTheme.typography.bodyLarge)
				OutlinedButton(onClick = hapticClick(onRetry)) { Text("Retry") }
				if (root.canPlace) Button(onClick = hapticClick(onConfigure)) { Text("Configure") }
			}
		}
	}
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
		AssistantPage.Settings ->
			AssistantSettingsPage(repo, state, home, onListDirs, onRules = { g, w -> onPage(AssistantPage.Rules(g, w)) }, onBack)
		is AssistantPage.Rules -> {
			val watcher = watcherOn(state.gateways.assistantOn(page.gatewayId), page.watcherId)
			if (watcher == null) {
				UnreadPage("Rules", repo, state, page.gatewayId, onBack)
			} else {
				WatcherRulesPage(repo, page.gatewayId, watcher, { onPage(AssistantPage.Editor(page.gatewayId, page.watcherId, it)) }, onBack)
			}
		}
		is AssistantPage.Editor -> {
			val watcher = watcherOn(state.gateways.assistantOn(page.gatewayId), page.watcherId)
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

private fun watcherOn(placed: ConsoleAssistantStateResult?, watcherId: String): AssistantWatcher? =
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
private fun AssistantSettingsPage(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onListDirs: suspend (String, String, String) -> DirListing,
	onRules: (String, String) -> Unit,
	onBack: () -> Unit,
) {
	val ops = repo.assistantOps
	val works by ops.work.collectAsState()
	val work = works[WorkKey.Settings] ?: PageWork()
	val busy = work.busy
	val gateways = state.gateways.ids()
	val placed = home?.let { state.gateways.assistantOn(it) }
	var target by rememberSaveable(home) { mutableStateOf(home ?: gateways.firstOrNull()) }
	val chosen = target?.let { state.gateways.assistantOn(it) }
	val folderText = placed?.workdir ?: DEFAULT_FOLDER
	var folder by rememberSaveable(home, stateSaver = TextFieldValue.Saver) {
		mutableStateOf(TextFieldValue(folderText, TextRange(folderText.length)))
	}
	// Leaving closes both dialogs.
	var granting by remember(home) { mutableStateOf<String?>(null) }
	var releasing by remember { mutableStateOf(false) }
	var opening by remember { mutableStateOf<Pair<String, String>?>(null) }
	val waitingSends by repo.assistantSendOps.pending.collectAsState()
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val offered = remember(entries, home) { home?.let(entries::grantableOn).orEmpty() }
	val settings = { op: suspend AssistantOps.() -> String? ->
		repo.command { assistantOps.runWork(WorkKey.Settings, op) }
	}

	AssistantPageScaffold("Assistant settings", onBack) {
		work.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		for (section in assistantSections(home, placed, chosen)) {
			when (section) {
				AssistantSection.LIVES_ON -> {
					Text("Lives on", style = MaterialTheme.typography.labelLarge)
					val others = state.gateways.assistantHomes().filter { it != home }
					if (others.isNotEmpty()) {
						Text(
							"Also placed on ${others.joinToString()}. Move it to release the rest.",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.error,
						)
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
					if (picked != null && domainId != null) {
						DirectoryField(
							value = folder,
							onValueChange = { folder = it },
							spawn = ASSISTANT_SPAWN,
							onListDirs = { path, spawn ->
								val hostTarget = runIsolated { SpawnPoint.of(domainId, picked, spawn).canonical }.getOrNull()
								if (hostTarget == null) DirListing(emptyList()) else onListDirs(path, hostTarget, spawn)
							},
						)
					}
					Button(
						onClick = hapticClick {
							val to = picked ?: return@hapticClick
							val workdir = folderOf(folder.text)
							settings { movedText(move(to, workdir)) }
						},
						enabled = !busy && placementMoves(home, picked, folder.text, placed?.workdir),
					) { Text(if (home == null) "Place here" else "Move here") }
				}
				AssistantSection.SAFETY -> {
					val gatewayId = target ?: continue
					val approveEverySend = chosen?.approveEverySend ?: continue
					HorizontalDivider()
					Text("Safety", style = MaterialTheme.typography.labelLarge)
					Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
						Text("Approve every send", modifier = Modifier.weight(1f))
						Switch(
							checked = approveEverySend,
							onCheckedChange = { enabled -> settings { answerText(setSafety(gatewayId, enabled)) } },
							enabled = !busy,
						)
					}
					for (send in sendsWaitingOn(waitingSends, gatewayId)) {
						TextButton(onClick = hapticClick { opening = gatewayId to send.request.requestId }) {
							Text(assistantSendRowText(send.request))
						}
					}
				}
				AssistantSection.WATCHERS -> {
					val at = home ?: continue
					val holding = placed ?: continue
					HorizontalDivider()
					Text("Watchers", style = MaterialTheme.typography.labelLarge)
					for (watcher in holding.watchers) {
						WatcherBlock(
							watcher = watcher,
							grantLine = grantedLine(watcher.grants, entries),
							busy = busy,
							onAssign = { granting = watcher.id },
							onRules = { onRules(at, watcher.id) },
							onRetry = { settings { answerText(retry(at, watcher)) } },
						)
					}
					HorizontalDivider()
					TextButton(onClick = hapticClick { releasing = true }, enabled = !busy) { Text("Release from $at") }
				}
			}
		}
	}

	val grantFor = granting?.let { watcherId -> placed?.watchers?.find { it.id == watcherId } }
	if (home != null && grantFor != null) {
		GrantSecretsSheet(
			entries = offered,
			granted = grantFor.grants,
			onDone = { picks ->
				granting = null
				settings { answerText(setGrants(home, grantFor.id, picks)) }
			},
			onDismiss = { granting = null },
			needs = grantFor.secret,
		)
	}

	opening?.let { (gatewayId, requestId) -> AssistantSendSheet(repo, gatewayId, requestId) { opening = null } }

	if (releasing && home != null) {
		ConfirmDialog(
			title = "Release the assistant from $home?",
			body = "Ends its session there and stops its watchers. Its notes folder stays.",
			confirmText = "Release",
			onConfirm = {
				releasing = false
				settings { answerText(release(home)) }
			},
			onDismiss = { releasing = false },
		)
	}
}

@Composable
private fun WatcherBlock(
	watcher: AssistantWatcher,
	grantLine: String,
	busy: Boolean,
	onAssign: () -> Unit,
	onRules: () -> Unit,
	onRetry: () -> Unit,
) {
	Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
		Text(watcher.label, style = MaterialTheme.typography.titleSmall)
		Text(
			watcherHealth(watcher, ::agoText),
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		watcher.secret?.let { SecretNeeded(it) }
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			Text(grantLine, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
			OutlinedButton(onClick = hapticClick(onAssign), enabled = !busy) { Text("Assign secret") }
		}
		val may = watcherActions(watcher)
		if (may.isNotEmpty()) {
			Text("The assistant may", style = MaterialTheme.typography.labelMedium)
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
			Text("Seen outside its lists", style = MaterialTheme.typography.labelMedium)
			for (line in unexpected) {
				Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		if (canRetry(watcher)) {
			TextButton(onClick = hapticClick(onRetry), enabled = !busy) { Text("Retry") }
		}
	}
}

private fun agoText(at: Long): String = relativeTime(at).let { if (it == "now") "just now" else "$it ago" }
