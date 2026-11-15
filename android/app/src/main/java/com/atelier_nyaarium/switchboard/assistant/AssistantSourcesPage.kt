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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import com.atelier_nyaarium.switchboard.NoHome
import com.atelier_nyaarium.switchboard.noHome
import com.atelier_nyaarium.switchboard.devicesPending
import com.atelier_nyaarium.switchboard.servicesWaiting
import com.atelier_nyaarium.switchboard.homeHolding
import com.atelier_nyaarium.switchboard.isSensor
import com.atelier_nyaarium.switchboard.mainValue
import com.atelier_nyaarium.switchboard.rowBrandLine
import com.atelier_nyaarium.switchboard.saidOf
import com.atelier_nyaarium.switchboard.sensorOf
import com.atelier_nyaarium.switchboard.sensorTrouble
import com.atelier_nyaarium.switchboard.serviceRows
import com.atelier_nyaarium.switchboard.sourceGroups
import com.atelier_nyaarium.switchboard.sourceHealth
import com.atelier_nyaarium.switchboard.sourceTroubled
import com.atelier_nyaarium.switchboard.troubleLine

/** Devices by Gateway, then the home's services. */
@Composable
internal fun SourcesView(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	/** A session's Gateway, listed first. */
	lead: String?,
	onDevice: (String, String) -> Unit,
	onService: (String, String) -> Unit,
	onSource: (String, String) -> Unit,
	modifier: Modifier = Modifier,
) {
	val holding = homeHolding(home?.let(state.gateways::assistantRead))
	val (on, off) = remember(holding) { holding.sources.partition { it.enabled } }
	var showDisabled by rememberSaveable { mutableStateOf(false) }
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val services = remember(holding.integrations, entries) { serviceRows(holding.integrations, entries) }
	val views by repo.deviceOps.views.collectAsState()
	val roster = state.gateways.ids()
	val reach = roster.map { gatewayId -> gatewayId to state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation } }
	LaunchedEffect(home, reach) {
		if (home != null) for (gatewayId in roster) repo.command { deviceOps.refresh(gatewayId) }
	}
	val display = holding.display
	val works by repo.assistantOps.work.collectAsState()
	val unitsBusy = works[WorkKey.Units]?.busy == true
	val unitsSaid = works[WorkKey.Units]?.said
	val now = System.currentTimeMillis()

	PageColumn(modifier) {
		if (home == null) {
			when (noHome(state)) {
				NoHome.READING -> CircularProgressIndicator(Modifier.size(24.dp))
				NoHome.ROUTER_UNREACHABLE ->
					Text("Could not reach the Federation Router.", style = MaterialTheme.typography.bodyLarge)
				NoHome.NOT_PLACED -> Text(PLACE_FIRST, style = MaterialTheme.typography.bodyLarge)
			}
			return@PageColumn
		}
		val hasServices = on.isNotEmpty() || off.isNotEmpty() || services.isNotEmpty()
		val groups = sourceGroups(roster, home, views, hasServices, lead)
		val serviceRows: @Composable () -> Unit = {
			SubLabel("Services")
			for (source in on) {
				SourceRow(source.label, sourceHealth(source, ::agoText), sourceTroubled(source)) { onSource(home, source.id) }
			}
			for (service in services) ServiceRowView(service) { onService(home, service.id) }
			if (off.isNotEmpty()) {
				FoldRow("Disabled", showDisabled) { showDisabled = !showDisabled }
				if (showDisabled) for (source in off) SourceRow(source.label, null, false) { onSource(home, source.id) }
			}
		}
		servicesWaiting(state.gateways.assistantRead(home))?.let { line ->
			SubLabel("Services")
			if (line.isEmpty()) CircularProgressIndicator(Modifier.size(24.dp)) else Text(line, style = MaterialTheme.typography.bodyMedium)
		}
		if (devicesPending(roster, views)) CircularProgressIndicator(Modifier.size(24.dp))
		for (group in groups) {
			val devices = views[group.gatewayId] ?: DevicesView()
			val withServices = group.assistant && hasServices
			GatewayHeader(group.gatewayId, group.assistant)
			if (withServices && group.records.isNotEmpty()) SubLabel("Devices")
			for (record in group.records) {
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
			if (withServices) serviceRows()
		}
		holding.temperatureUnit?.let { unit ->
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
private fun GatewayHeader(gatewayId: String, assistant: Boolean) {
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Text(gatewayId, style = MaterialTheme.typography.labelLarge)
		if (assistant) AssistantChip()
	}
}

@Composable
private fun SubLabel(text: String) {
	Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun AssistantChip() {
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
