package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.DeviceListView
import com.atelier_nyaarium.switchboard.DeviceLive
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.ServiceRow
import com.atelier_nyaarium.switchboard.alert
import com.atelier_nyaarium.switchboard.brandLine
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.capabilitiesOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.kindGroups
import com.atelier_nyaarium.switchboard.kindTitle
import com.atelier_nyaarium.switchboard.PowerSlot
import com.atelier_nyaarium.switchboard.liveOf
import com.atelier_nyaarium.switchboard.powerSlot
import com.atelier_nyaarium.switchboard.proto.DeviceCapability
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.retryable
import com.atelier_nyaarium.switchboard.serviceRows
import com.atelier_nyaarium.switchboard.troubleLine

@Composable
internal fun AssistantIntegrationsPage(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onAdd: () -> Unit,
	onDevice: (String, String) -> Unit,
	onService: (String, String) -> Unit,
	onBack: () -> Unit,
) {
	val holding = home?.let { state.gateways.assistantOn(it) }
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val services = remember(holding?.integrations, entries) { serviceRows(holding?.integrations, entries) }
	val views by repo.deviceOps.views.collectAsState()
	val devices = home?.let { views[it] } ?: DevicesView()
	val reach = home?.let { gatewayId ->
		state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation }
	}
	LaunchedEffect(home, reach) {
		home?.let { gatewayId -> repo.command { deviceOps.refresh(gatewayId) } }
	}

	AssistantPageScaffold(
		"Integrations",
		onBack,
		actions = { if (home != null) Button(onClick = hapticClick(onAdd)) { Text("Add") } },
	) {
		if (home == null) {
			Text(PLACE_FIRST, style = MaterialTheme.typography.bodyLarge)
			return@AssistantPageScaffold
		}
		val list = devices.list
		val listed = (list as? DeviceListView.Listed)?.records.orEmpty()
		if (list is DeviceListView.Unavailable) {
			Text(list.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			if (list.retryable()) OutlinedButton(onClick = hapticClick { repo.command { deviceOps.refresh(home) } }) { Text("Retry") }
		}
		if (list == DeviceListView.Loading) CircularProgressIndicator(Modifier.size(24.dp))
		if (listed.isNotEmpty()) {
			Text("Devices", style = MaterialTheme.typography.labelLarge)
			for (group in kindGroups(listed)) {
				Text(kindTitle(group.kind), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				for (record in group.records) {
					DeviceRow(
						record,
						devices.liveOf(record.id),
						busy = devices.busy(record.id),
						said = devices.alert(record.id),
						onOpen = { onDevice(home, record.id) },
						onSwitch = { on -> repo.command { deviceOps.set(home, record.id, on) } },
					)
				}
			}
		}
		if (services.isNotEmpty()) {
			if (listed.isNotEmpty()) HorizontalDivider()
			Text("Services", style = MaterialTheme.typography.labelLarge)
			for (service in services) ServiceRowView(service) { onService(home, service.id) }
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
			Text(brandLine(record), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			troubleLine(live)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		if (DeviceCapability.SWITCH in capabilitiesOf(record)) PowerControl(live, busy, onSwitch)
	}
}

@Composable
private fun ServiceRowView(service: ServiceRow, onOpen: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(service.label, style = MaterialTheme.typography.bodyLarge)
			Text(service.grantedLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}

@Composable
internal fun PowerControl(live: DeviceLive?, busy: Boolean, onSet: (Boolean) -> Unit) {
	when (val slot = powerSlot(live)) {
		is PowerSlot.Switch -> Switch(checked = slot.on, onCheckedChange = onSet, enabled = !busy)
		PowerSlot.Reading -> Box(Modifier.width(52.dp), contentAlignment = Alignment.Center) {
			CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
		}
		PowerSlot.Hidden -> Unit
	}
}
