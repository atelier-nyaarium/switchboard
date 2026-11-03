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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.DeviceListView
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.PageWork
import com.atelier_nyaarium.switchboard.ScanView
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.addable
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.catalogued
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.nameReady
import com.atelier_nyaarium.switchboard.paired
import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.Integration
import com.atelier_nyaarium.switchboard.proto.IntegrationDiscovery
import com.atelier_nyaarium.switchboard.proto.IntegrationNeedKind
import com.atelier_nyaarium.switchboard.proto.IntegrationSetup
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.saidOf
import com.atelier_nyaarium.switchboard.serviceEntry

/** One catalogue entry: discovery decides the page. */
@Composable
internal fun IntegrationEntryPage(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	integrationId: String,
	onDevice: (String) -> Unit,
	onSetup: () -> Unit,
	onAdded: () -> Unit,
	onBack: () -> Unit,
) {
	val integration = catalogued(integrationId)
	if (integration == null) {
		LaunchedEffect(integrationId) { onBack() }
		return
	}
	when (integration.discovery) {
		IntegrationDiscovery.SCAN -> ScanEntryPage(repo, state, gatewayId, integration, onDevice, onSetup, onBack)
		IntegrationDiscovery.LISTEN -> AssistantPageScaffold(integration.label, onBack) {}
		IntegrationDiscovery.NONE -> NeedsEntryPage(repo, state, gatewayId, integration, onAdded, onBack)
	}
}

@Composable
private fun ScanEntryPage(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	integration: Integration,
	onDevice: (String) -> Unit,
	onSetup: () -> Unit,
	onBack: () -> Unit,
) {
	val views by repo.deviceOps.views.collectAsState()
	val devices = views[gatewayId] ?: DevicesView()
	var adding by remember(gatewayId) { mutableStateOf<DeviceCandidate?>(null) }
	val reach = state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation }
	LaunchedEffect(gatewayId, reach) { repo.command { deviceOps.relist(gatewayId) } }
	val scan = devices.scan

	AssistantPageScaffold(
		integration.label,
		onBack,
		actions = {
			if (scan == ScanView.Scanning) {
				CircularProgressIndicator(Modifier.padding(horizontal = 14.dp).size(24.dp))
			} else {
				OutlinedButton(onClick = hapticClick { repo.command { deviceOps.scan(gatewayId) } }) { Text("Scan") }
			}
		},
	) {
		if (scan is ScanView.Failed) {
			Text(scan.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
		val fresh = devices.addable()?.takeIf { it.isNotEmpty() }
		if (fresh != null) {
			Text("Found", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			for (candidate in fresh) {
				CandidateRow(candidate, busy = devices.busy(candidate.mac), said = devices.saidOf(candidate.mac)) {
					repo.deviceOps.forget(gatewayId, candidate.mac)
					adding = candidate
				}
			}
		}
		integration.setup?.let { setup ->
			if (fresh != null) HorizontalDivider()
			NewDeviceRow(repo, gatewayId, setup, onSetup)
		}
		val paired = (devices.list as? DeviceListView.Listed)?.records.orEmpty().filter { it.driver == integration.id }
		if (paired.isNotEmpty()) {
			if (fresh != null || integration.setup != null) HorizontalDivider()
			Text("Paired", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			for (record in paired) {
				Row(
					Modifier.fillMaxWidth().clickable(onClick = hapticClick { onDevice(record.id) }).padding(vertical = 6.dp),
					verticalAlignment = Alignment.CenterVertically,
					horizontalArrangement = Arrangement.spacedBy(8.dp),
				) {
					Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
						Text(record.name, style = MaterialTheme.typography.bodyLarge)
						Text(record.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
	}

	val candidate = adding
	if (candidate != null) {
		if (devices.paired(candidate.mac)) {
			LaunchedEffect(candidate.mac) { adding = null }
		} else {
			AddDeviceDialog(
				candidate,
				busy = devices.busy(candidate.mac),
				said = devices.saidOf(candidate.mac),
				onAdd = { name -> repo.command { deviceOps.add(gatewayId, candidate, name) } },
				onDismiss = { adding = null },
			)
		}
	}
}

/** A fresh device in setup mode; the phone's picker finds it. */
@Composable
private fun NewDeviceRow(repo: ChatRepository, gatewayId: String, setup: IntegrationSetup, onSetup: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Text("New device", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
		OutlinedButton(onClick = hapticClick {
			repo.command { plugSetupOps.start(gatewayId, setup.networkPrefix) }
			onSetup()
		}) { Text("Set up") }
	}
}

@Composable
private fun CandidateRow(candidate: DeviceCandidate, busy: Boolean, said: String?, onAdd: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(candidate.alias.ifBlank { candidate.model }, style = MaterialTheme.typography.bodyLarge)
			Text("${candidate.model} · ${candidate.address}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		OutlinedButton(onClick = hapticClick(onAdd), enabled = !busy) { Text("Add") }
	}
}

@Composable
private fun AddDeviceDialog(
	candidate: DeviceCandidate,
	busy: Boolean,
	said: String?,
	onAdd: (String) -> Unit,
	onDismiss: () -> Unit,
) {
	var name by rememberSaveable(candidate.mac) { mutableStateOf(candidate.alias) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Add device") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true)
				said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
			}
		},
		confirmButton = {
			TextButton(onClick = hapticClick { onAdd(name.trim()) }, enabled = !busy && nameReady(name)) {
				if (busy) CircularProgressIndicator(Modifier.size(18.dp)) else Text("Add")
			}
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

/** A service: what it needs, granted from the vault; the first grant adds it. */
@Composable
private fun NeedsEntryPage(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	integration: Integration,
	onAdded: () -> Unit,
	onBack: () -> Unit,
) {
	val holding = state.gateways.assistantOn(gatewayId)
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val service = remember(holding?.integrations, entries, gatewayId) {
		serviceEntry(integration, holding?.integrations, entries, gatewayId)
	}
	val works by repo.assistantOps.work.collectAsState()
	val key = WorkKey.Watcher(gatewayId, integration.id)
	val work = works[key] ?: PageWork()
	var choosing by rememberSaveable(integration.id) { mutableStateOf(false) }
	var removing by remember { mutableStateOf(false) }
	val added = service?.grants?.isNotEmpty() == true
	// Baseline waits for the state answer.
	var baseline by remember(integration.id) { mutableStateOf<Boolean?>(null) }
	LaunchedEffect(holding != null, added) {
		if (holding == null) return@LaunchedEffect
		if (baseline == null) baseline = added else if (added && baseline == false) onAdded()
	}

	AssistantPageScaffold(integration.label, onBack) {
		work.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		if (service == null) return@AssistantPageScaffold
		for (need in integration.needs) {
			when (need.kind) {
				IntegrationNeedKind.SECRET -> Row(
					verticalAlignment = Alignment.CenterVertically,
					horizontalArrangement = Arrangement.spacedBy(8.dp),
					modifier = Modifier.fillMaxWidth(),
				) {
					Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
						Text(need.label, style = MaterialTheme.typography.bodyLarge)
						Text(service.grantedLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					OutlinedButton(onClick = hapticClick { choosing = true }, enabled = !work.busy) {
						Text(if (added) "Change key" else "Choose key")
					}
				}
			}
		}
		if (added) {
			HorizontalDivider()
			OutlinedButton(
				onClick = hapticClick { removing = true },
				enabled = !work.busy,
				colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
			) { Text("Remove service") }
		}
	}

	if (choosing && service != null) {
		GrantSecretsSheet(
			entries = service.offered,
			granted = service.grants,
			onDone = { picks ->
				choosing = false
				repo.command { assistantOps.runWork(key) { answerText(setGrants(gatewayId, integration.id, picks)) } }
			},
			onDismiss = { choosing = false },
		)
	}
	if (removing) {
		ConfirmDialog(
			title = "Remove ${integration.label}?",
			body = null,
			confirmText = "Remove",
			onConfirm = {
				removing = false
				repo.command { assistantOps.runWork(key) { answerText(setGrants(gatewayId, integration.id, emptyList())) } }
			},
			onDismiss = { removing = false },
		)
	}
}
