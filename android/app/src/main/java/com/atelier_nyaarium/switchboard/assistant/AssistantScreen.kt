package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.DirListing
import com.atelier_nyaarium.switchboard.DirectoryField
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.AssistantRoot
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.canRetry
import com.atelier_nyaarium.switchboard.folderOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.movedText
import com.atelier_nyaarium.switchboard.placementMoves
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.relativeTime
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.routines.SecretNeeded
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.vault.grantableOn
import com.atelier_nyaarium.switchboard.watcherActions
import com.atelier_nyaarium.switchboard.watcherHealth
import kotlinx.coroutines.launch

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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AssistantSettingsSheet(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onListDirs: suspend (String, String, String) -> DirListing,
	onDismiss: () -> Unit,
) {
	val scope = rememberCoroutineScope()
	val gateways = state.gateways.ids()
	val placed = home?.let { state.gateways.assistantOn(it) }
	var target by remember(home) { mutableStateOf(home ?: gateways.firstOrNull()) }
	val folderText = placed?.workdir ?: DEFAULT_FOLDER
	var folder by remember(home) { mutableStateOf(TextFieldValue(folderText, TextRange(folderText.length))) }
	var busy by remember { mutableStateOf(false) }
	var said by remember { mutableStateOf<String?>(null) }
	/** Sheet targets; a moved home closes them. */
	var granting by remember(home) { mutableStateOf<Pair<String, String>?>(null) }
	var ruling by remember(home) { mutableStateOf<Pair<String, String>?>(null) }
	var releasing by remember { mutableStateOf(false) }
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val offered = remember(entries, home) { home?.let(entries::grantableOn).orEmpty() }

	ModalBottomSheet(onDismissRequest = onDismiss) {
		Column(
			Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text("Assistant settings", style = MaterialTheme.typography.titleLarge)

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
					busy = true
					scope.launch {
						said = movedText(repo.assistantOps.move(to, folderOf(folder.text)))
						busy = false
					}
				},
				enabled = !busy && placementMoves(home, picked, folder.text, placed?.workdir),
			) { Text(if (home == null) "Place here" else "Move here") }
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

			if (home != null && placed != null) {
				HorizontalDivider()
				Text("Watchers", style = MaterialTheme.typography.labelLarge)
				for (watcher in placed.watchers) {
					Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
						Text(watcher.label, style = MaterialTheme.typography.titleSmall)
						Text(
							watcherHealth(watcher, ::agoText),
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
						watcher.secret?.let { SecretNeeded(it) }
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
						Text(grantedLine(watcher.grants, entries), style = MaterialTheme.typography.bodyMedium)
						Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
							OutlinedButton(onClick = hapticClick { granting = home to watcher.id }, enabled = !busy) {
								Text("Assign secret")
							}
							if (rulesOf(watcher) != null) {
								OutlinedButton(onClick = hapticClick { ruling = home to watcher.id }, enabled = !busy) {
									Text("Rules")
								}
							}
							if (canRetry(watcher)) {
								TextButton(
									onClick = hapticClick { scope.launch { said = answerText(repo.assistantOps.retry(home, watcher)) } },
									enabled = !busy,
								) { Text("Retry") }
							}
						}
					}
				}

				HorizontalDivider()
				TextButton(onClick = hapticClick { releasing = true }, enabled = !busy) { Text("Release from $home") }
			}
		}
	}

	val opened = granting
	val grantFor = opened?.takeIf { it.first == home }?.let { (_, watcherId) -> placed?.watchers?.find { it.id == watcherId } }
	if (opened != null && grantFor != null) {
		GrantSecretsSheet(
			entries = offered,
			granted = grantFor.grants,
			onDone = { picks ->
				granting = null
				scope.launch { said = answerText(repo.assistantOps.setGrants(opened.first, grantFor.id, picks)) }
			},
			onDismiss = { granting = null },
			needs = grantFor.secret,
		)
	}

	val rulesOpen = ruling
	val rulesFor = rulesOpen?.takeIf { it.first == home }?.let { (_, watcherId) -> placed?.watchers?.find { it.id == watcherId } }
	if (rulesOpen != null && rulesFor != null) {
		WatcherRulesSheet(repo.assistantOps, rulesOpen.first, rulesFor) { ruling = null }
	}

	if (releasing && home != null) {
		ConfirmDialog(
			title = "Release the assistant from $home?",
			body = "Ends its session there and stops its watchers. Its notes folder stays.",
			confirmText = "Release",
			onConfirm = {
				releasing = false
				busy = true
				scope.launch {
					said = answerText(repo.assistantOps.release(home))
					busy = false
				}
			},
			onDismiss = { releasing = false },
		)
	}
}

private fun agoText(at: Long): String = relativeTime(at).let { if (it == "now") "just now" else "$it ago" }
