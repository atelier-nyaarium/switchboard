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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AssistantOps
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.PageWork
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.canRetry
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.inboxCount
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.relativeTime
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.routines.SecretNeeded
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.sourceHealth
import com.atelier_nyaarium.switchboard.sourceTroubled
import com.atelier_nyaarium.switchboard.unexpectedLines
import com.atelier_nyaarium.switchboard.vault.grantableOn

/** Red when troubled. */
@Composable
internal fun SourceRow(label: String, health: String?, troubled: Boolean, onOpen: () -> Unit) {
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
internal fun FoldRow(label: String, open: Boolean, onToggle: () -> Unit) {
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
internal fun AssistantSourcePage(
	repo: ChatRepository,
	gatewayId: String,
	source: AssistantSource,
	/** Automations triggered by it; null from a Gateway that lists none. */
	uses: Int?,
	onAutomations: () -> Unit,
	onBack: () -> Unit,
) {
	val key = WorkKey.Source(gatewayId, source.id)
	val works by repo.assistantOps.work.collectAsState()
	val work = works[key] ?: PageWork()
	val busy = work.busy
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val offered = remember(entries, gatewayId) { entries.grantableOn(gatewayId) }
	var granting by remember { mutableStateOf(false) }
	val run = { op: suspend AssistantOps.() -> String? -> repo.command { assistantOps.runWork(key, op) } }
	val dim = MaterialTheme.colorScheme.onSurfaceVariant

	AssistantPageScaffold(source.label, onBack) {
		work.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
			Text("Enabled", modifier = Modifier.weight(1f))
			Switch(
				checked = source.enabled,
				onCheckedChange = { enabled -> run { answerText(setEnabled(gatewayId, source.id, enabled)) } },
				enabled = !busy,
			)
		}
		if (source.enabled) {
			Text(
				sourceHealth(source, ::agoText),
				style = MaterialTheme.typography.bodySmall,
				color = if (sourceTroubled(source)) MaterialTheme.colorScheme.error else dim,
			)
		}
		source.secret?.let { needs ->
			HorizontalDivider()
			Text("Secret", style = MaterialTheme.typography.labelLarge)
			SecretNeeded(needs)
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(grantedLine(source.grants, entries), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
				OutlinedButton(onClick = hapticClick { granting = true }, enabled = !busy) { Text("Assign secret") }
			}
		}
		HorizontalDivider()
		Text("Produces", style = MaterialTheme.typography.labelLarge)
		Column {
			Text("Events", style = MaterialTheme.typography.bodyMedium)
			Text(producesText(source.fieldSpecs), style = MaterialTheme.typography.bodySmall, color = dim)
		}
		HorizontalDivider()
		Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
			Text("Inbox", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
			Text(inboxCount(source), style = MaterialTheme.typography.bodyMedium, color = dim)
		}
		if (source.actions.isNotEmpty()) {
			HorizontalDivider()
			Text("Commands", style = MaterialTheme.typography.labelLarge)
			for (action in source.actions) {
				Column {
					Text(action.label, style = MaterialTheme.typography.bodyMedium)
					Text(action.description, style = MaterialTheme.typography.bodySmall, color = dim)
				}
			}
		}
		if (source.triggers && uses != null) {
			HorizontalDivider()
			Row(
				Modifier.fillMaxWidth().clickable(onClick = hapticClick(onAutomations)).padding(vertical = 8.dp),
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(8.dp),
			) {
				Column(Modifier.weight(1f)) {
					Text("Automations", style = MaterialTheme.typography.bodyLarge)
					Text(usesText(uses), style = MaterialTheme.typography.bodySmall, color = dim)
				}
				Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
			}
		}
		val unexpected = unexpectedLines(source)
		if (unexpected.isNotEmpty()) {
			Text("Seen outside its lists", style = MaterialTheme.typography.labelLarge)
			for (line in unexpected) Text(line, style = MaterialTheme.typography.bodySmall, color = dim)
		}
		if (canRetry(source)) {
			TextButton(onClick = hapticClick { run { answerText(retry(gatewayId, source)) } }, enabled = !busy) { Text("Retry") }
		}
	}

	if (granting) {
		GrantSecretsSheet(
			entries = offered,
			granted = source.grants,
			onDone = { picks ->
				granting = false
				run { answerText(setGrants(gatewayId, source.id, picks)) }
			},
			onDismiss = { granting = false },
			needs = source.secret,
		)
	}
}

internal fun agoText(at: Long): String = relativeTime(at).let { if (it == "now") "just now" else "$it ago" }
