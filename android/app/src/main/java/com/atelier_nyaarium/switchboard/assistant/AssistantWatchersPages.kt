package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AssistantOps
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.PageWork
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.canRetry
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.relativeTime
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.routines.SecretNeeded
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.rulesCountText
import com.atelier_nyaarium.switchboard.unexpectedLines
import com.atelier_nyaarium.switchboard.vault.grantableOn
import com.atelier_nyaarium.switchboard.watcherActions
import com.atelier_nyaarium.switchboard.watcherHealth
import com.atelier_nyaarium.switchboard.watcherOn
import com.atelier_nyaarium.switchboard.watcherTroubled

@Composable
internal fun AssistantWatchersPage(
	state: ChatState,
	home: String?,
	onWatcher: (String, String) -> Unit,
	onBack: () -> Unit,
) {
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
internal fun AssistantWatcherPage(
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
