package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.alert
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.capabilitiesOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.PowerSlot
import com.atelier_nyaarium.switchboard.liveOf
import com.atelier_nyaarium.switchboard.powerSlot
import com.atelier_nyaarium.switchboard.proto.DeviceCapability
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.MainValue
import com.atelier_nyaarium.switchboard.deviceGroups
import com.atelier_nyaarium.switchboard.displayUnitOf
import com.atelier_nyaarium.switchboard.isSensor
import com.atelier_nyaarium.switchboard.mainValue
import com.atelier_nyaarium.switchboard.rowBrandLine
import com.atelier_nyaarium.switchboard.saidOf
import com.atelier_nyaarium.switchboard.sensorOf
import com.atelier_nyaarium.switchboard.sensorTrouble
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
	val roster = state.gateways.ids()
	val reach = roster.map { gatewayId -> gatewayId to state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation } }
	LaunchedEffect(home, reach) {
		if (home != null) for (gatewayId in roster) repo.command { deviceOps.refresh(gatewayId) }
	}
	val display = displayUnitOf(holding)
	val works by repo.assistantOps.work.collectAsState()
	val unitsBusy = works[WorkKey.Units]?.busy == true
	val unitsSaid = works[WorkKey.Units]?.said
	val now = System.currentTimeMillis()

	AssistantPageScaffold(
		"Integrations",
		onBack,
		actions = { if (home != null) Button(onClick = hapticClick(onAdd)) { Text("Add") } },
	) {
		if (home == null) {
			Text(PLACE_FIRST, style = MaterialTheme.typography.bodyLarge)
			return@AssistantPageScaffold
		}
		val groups = deviceGroups(roster, home, views)
		for (group in groups) {
			val devices = views[group.gatewayId] ?: DevicesView()
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(group.gatewayId, style = MaterialTheme.typography.labelLarge)
				if (group.assistant) AssistantChip()
			}
			when (val list = group.list) {
				DeviceListView.Loading -> CircularProgressIndicator(Modifier.size(24.dp))
				is DeviceListView.Unavailable -> {
					Text(list.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
					OutlinedButton(onClick = hapticClick { repo.command { deviceOps.refresh(group.gatewayId) } }) { Text("Retry") }
				}
				is DeviceListView.Listed -> for (record in list.records) {
					if (record.isSensor()) {
						SensorRow(
							record,
							mainValue(devices.sensorOf(record.id), display),
							sensorTrouble(devices.sensorOf(record.id), now),
							said = devices.saidOf(record.id),
							onOpen = { onDevice(group.gatewayId, record.id) },
						)
					} else {
						DeviceRow(
							record,
							devices.liveOf(record.id),
							busy = devices.busy(record.id),
							said = devices.alert(record.id),
							onOpen = { onDevice(group.gatewayId, record.id) },
							onSwitch = { on -> repo.command { deviceOps.set(group.gatewayId, record.id, on) } },
						)
					}
				}
				DeviceListView.Declined -> Unit
			}
		}
		if (services.isNotEmpty()) {
			if (groups.isNotEmpty()) HorizontalDivider()
			Text("Services", style = MaterialTheme.typography.labelLarge)
			for (service in services) ServiceRowView(service) { onService(home, service.id) }
		}
		holding?.temperatureUnit?.let { unit ->
			HorizontalDivider()
			UnitRow(unit, busy = unitsBusy) { picked ->
				repo.command { assistantOps.runWork(WorkKey.Units) { answerText(setTemperatureUnit(home, picked)) } }
			}
			unitsSaid?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
	}
}

private val TEMPERATURE_UNITS = listOf("C" to "°C", "F" to "°F")

@Composable
private fun UnitRow(unit: String, busy: Boolean, onPick: (String) -> Unit) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Temperature", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
		SingleChoiceSegmentedButtonRow(Modifier.width(128.dp)) {
			TEMPERATURE_UNITS.forEachIndexed { at, (value, label) ->
				SegmentedButton(
					selected = unit == value,
					onClick = hapticClick { if (unit != value) onPick(value) },
					shape = SegmentedButtonDefaults.itemShape(index = at, count = TEMPERATURE_UNITS.size),
					enabled = !busy,
					icon = {},
				) { Text(label) }
			}
		}
	}
}

@Composable
private fun AssistantChip() {
	Text(
		"Assistant",
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSecondaryContainer,
		modifier = Modifier
			.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(50))
			.padding(horizontal = 8.dp, vertical = 2.dp),
	)
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
			Text(rowBrandLine(record), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			troubleLine(live)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		if (DeviceCapability.SWITCH in capabilitiesOf(record)) PowerControl(live, busy, onSwitch)
	}
}

@Composable
private fun SensorRow(record: DeviceRecord, value: MainValue?, trouble: String?, said: String?, onOpen: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(record.name, style = MaterialTheme.typography.bodyLarge)
			Text(rowBrandLine(record), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			trouble?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		value?.let {
			Text(
				it.text,
				style = MaterialTheme.typography.bodyLarge,
				color = if (it.stale) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
			)
		}
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
