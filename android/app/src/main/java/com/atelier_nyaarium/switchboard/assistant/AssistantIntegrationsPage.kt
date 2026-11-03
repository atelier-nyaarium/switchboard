package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
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
import com.atelier_nyaarium.switchboard.DeviceListView
import com.atelier_nyaarium.switchboard.DeviceLive
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.LEGACY_KASA_LINE
import com.atelier_nyaarium.switchboard.PageWork
import com.atelier_nyaarium.switchboard.ScanView
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.liveLine
import com.atelier_nyaarium.switchboard.liveOf
import com.atelier_nyaarium.switchboard.nameReady
import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.scanButtonText
import com.atelier_nyaarium.switchboard.knownOn
import com.atelier_nyaarium.switchboard.addable
import com.atelier_nyaarium.switchboard.alert
import com.atelier_nyaarium.switchboard.paired
import com.atelier_nyaarium.switchboard.retryable
import com.atelier_nyaarium.switchboard.saidOf

/** Devices and service secrets. */
@Composable
internal fun AssistantIntegrationsPage(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onDevice: (String, String) -> Unit,
	onBack: () -> Unit,
) {
	val holding = home?.let { state.gateways.assistantOn(it) }
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val integrations = remember(holding?.integrations, entries, home) {
		integrationRows(holding?.integrations, entries, home)
	}
	val works by repo.assistantOps.work.collectAsState()
	val views by repo.deviceOps.views.collectAsState()
	val devices = home?.let { views[it] } ?: DevicesView()
	var granting by rememberSaveable(home) { mutableStateOf<String?>(null) }
	var adding by remember(home) { mutableStateOf<DeviceCandidate?>(null) }
	val reach = home?.let { gatewayId ->
		state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation }
	}
	LaunchedEffect(home, reach) {
		home?.let { gatewayId -> repo.command { deviceOps.refresh(gatewayId) } }
	}

	AssistantPageScaffold(
		"Integrations",
		onBack,
		actions = {
			if (home != null) {
				IconButton(onClick = hapticClick { repo.command { deviceOps.refresh(home) } }) {
					Icon(Icons.Default.Refresh, contentDescription = "Refresh")
				}
			}
		},
	) {
		if (home == null) {
			Text(PLACE_FIRST, style = MaterialTheme.typography.bodyLarge)
		} else {
			Text("Devices", style = MaterialTheme.typography.labelLarge)
			DeviceList(
				devices,
				onOpen = { onDevice(home, it) },
				onSwitch = { id, on -> repo.command { deviceOps.set(home, id, on) } },
				onRetry = { repo.command { deviceOps.refresh(home) } },
			)
			ScanSection(
				devices,
				onScan = { repo.command { deviceOps.scan(home) } },
				onAdd = { candidate ->
					repo.deviceOps.forget(home, candidate.mac)
					adding = candidate
				},
			)
			if (integrations.isNotEmpty()) {
				HorizontalDivider()
				Text("Services", style = MaterialTheme.typography.labelLarge)
				for (row in integrations) {
					val key = WorkKey.Watcher(home, row.integration.id)
					val work = works[key] ?: PageWork()
					work.said?.let {
						Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
					}
					Row(
						verticalAlignment = Alignment.CenterVertically,
						horizontalArrangement = Arrangement.spacedBy(8.dp),
						modifier = Modifier.fillMaxWidth(),
					) {
						Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
							Text(row.integration.label, style = MaterialTheme.typography.bodyLarge)
							Text(row.grantedLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
						}
						OutlinedButton(
							onClick = hapticClick { granting = row.integration.id },
							enabled = !work.busy,
						) { Text("Assign secret") }
					}
				}
			}
		}
	}

	val integration = integrationRowForGrant(integrations, granting)
	if (home != null && integration != null) {
		val key = WorkKey.Watcher(home, integration.integration.id)
		GrantSecretsSheet(
			entries = integration.offered,
			granted = integration.integration.grants,
			onDone = { picks ->
				granting = null
				repo.command {
					assistantOps.runWork(key) {
						answerText(setGrants(home, integration.integration.id, picks))
					}
				}
			},
			onDismiss = { granting = null },
		)
	}

	val candidate = adding
	if (home != null && candidate != null) {
		if (devices.paired(candidate.mac)) {
			LaunchedEffect(candidate.mac) { adding = null }
		} else {
			AddDeviceDialog(
				candidate,
				busy = devices.busy(candidate.mac),
				said = devices.saidOf(candidate.mac),
				onAdd = { name -> repo.command { deviceOps.add(home, candidate, name) } },
				onDismiss = { adding = null },
			)
		}
	}
}

@Composable
private fun DeviceList(devices: DevicesView, onOpen: (String) -> Unit, onSwitch: (String, Boolean) -> Unit, onRetry: () -> Unit) {
	when (val list = devices.list) {
		DeviceListView.Loading -> CircularProgressIndicator(Modifier.size(24.dp))
		is DeviceListView.Unavailable -> {
			Text(list.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			if (list.retryable()) OutlinedButton(onClick = hapticClick(onRetry)) { Text("Retry") }
		}
		is DeviceListView.Listed -> {
			if (list.records.isEmpty()) {
				Text("No plugs paired", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			for (record in list.records) {
				DeviceRow(
					record,
					devices.liveOf(record.id),
					busy = devices.busy(record.id),
					said = devices.alert(record.id),
					onOpen = { onOpen(record.id) },
					onSwitch = { on -> onSwitch(record.id, on) },
				)
			}
		}
	}
}

@Composable
private fun DeviceRow(
	record: DeviceRecord,
	live: DeviceLive?,
	busy: Boolean,
	said: String?,
	onOpen: () -> Unit,
	onSwitch: (Boolean) -> Unit,
) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(record.name, style = MaterialTheme.typography.bodyLarge)
			Text(liveLine(live), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		PowerControl(live, busy, onSwitch)
	}
}

/** Unknown state offers choices. */
@Composable
internal fun PowerControl(live: DeviceLive?, busy: Boolean, onSet: (Boolean) -> Unit) {
	val known = live.knownOn()
	if (known != null) {
		Switch(checked = known, onCheckedChange = onSet, enabled = !busy)
		return
	}
	SingleChoiceSegmentedButtonRow(Modifier.width(128.dp)) {
		listOf(true to "On", false to "Off").forEachIndexed { at, (on, label) ->
			SegmentedButton(
				selected = false,
				onClick = hapticClick { onSet(on) },
				shape = SegmentedButtonDefaults.itemShape(index = at, count = 2),
				enabled = !busy,
				icon = {},
			) { Text(label) }
		}
	}
}

@Composable
private fun ScanSection(devices: DevicesView, onScan: () -> Unit, onAdd: (DeviceCandidate) -> Unit) {
	val scan = devices.scan
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		OutlinedButton(onClick = hapticClick(onScan), enabled = scan != ScanView.Scanning) { Text(scanButtonText(scan)) }
		if (scan == ScanView.Scanning) CircularProgressIndicator(Modifier.size(20.dp))
	}
	Text(LEGACY_KASA_LINE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	when (scan) {
		is ScanView.Failed -> Text(scan.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		is ScanView.Found -> {
			val fresh = devices.addable() ?: return
			if (fresh.isEmpty()) {
				Text("No new plugs found", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			for (candidate in fresh) {
				Row(
					Modifier.fillMaxWidth(),
					verticalAlignment = Alignment.CenterVertically,
					horizontalArrangement = Arrangement.spacedBy(8.dp),
				) {
					Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
						Text(candidate.alias.ifBlank { candidate.model }, style = MaterialTheme.typography.bodyLarge)
						Text(
							"${candidate.model} · ${candidate.address}",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
						devices.saidOf(candidate.mac)?.let {
							Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
						}
					}
					OutlinedButton(onClick = hapticClick { onAdd(candidate) }, enabled = !devices.busy(candidate.mac)) {
						Text("Add")
					}
				}
			}
		}
		else -> {}
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
		title = { Text("Add plug") },
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
