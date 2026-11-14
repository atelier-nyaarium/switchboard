package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
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
import com.atelier_nyaarium.switchboard.ClockPickerDialog
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.DAY_INITIALS
import com.atelier_nyaarium.switchboard.DeviceListView
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.GATEWAY_DECLINED
import com.atelier_nyaarium.switchboard.ScheduleDraft
import com.atelier_nyaarium.switchboard.actOffered
import com.atelier_nyaarium.switchboard.alert
import com.atelier_nyaarium.switchboard.assistantGateway
import com.atelier_nyaarium.switchboard.brandLine
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.capabilitiesOf
import com.atelier_nyaarium.switchboard.clockLine
import com.atelier_nyaarium.switchboard.daysText
import com.atelier_nyaarium.switchboard.detailOf
import com.atelier_nyaarium.switchboard.detailRetry
import com.atelier_nyaarium.switchboard.displayUnitOf
import com.atelier_nyaarium.switchboard.deviceRecord
import com.atelier_nyaarium.switchboard.editOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.isSensor
import com.atelier_nyaarium.switchboard.liveLine
import com.atelier_nyaarium.switchboard.liveOf
import com.atelier_nyaarium.switchboard.providerActs
import com.atelier_nyaarium.switchboard.proto.ActTier
import com.atelier_nyaarium.switchboard.proto.DeviceCapability
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.IntegrationAct
import com.atelier_nyaarium.switchboard.proto.KasaSettingPut
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.renameReady
import com.atelier_nyaarium.switchboard.retryable
import com.atelier_nyaarium.switchboard.scheduleBase
import com.atelier_nyaarium.switchboard.scheduleDraft
import com.atelier_nyaarium.switchboard.scheduleSavable
import com.atelier_nyaarium.switchboard.sensorOf
import com.atelier_nyaarium.switchboard.sensorSubtitle
import com.atelier_nyaarium.switchboard.sensorTrouble

private val SCHEDULE_ACTIONS = listOf(
	Protocol.Wire.DeviceScheduleAction.ON to "On",
	Protocol.Wire.DeviceScheduleAction.OFF to "Off",
)

/** One device: the generic top, then its brand's section. */
@Composable
internal fun AssistantDevicePage(repo: ChatRepository, gatewayId: String, deviceId: String, onBack: () -> Unit) {
	val views by repo.deviceOps.views.collectAsState()
	val state by repo.state.collectAsState()
	val view = views[gatewayId] ?: DevicesView()
	val record = deviceRecord(view, deviceId)
	val open = { repo.command { deviceOps.open(gatewayId, deviceId) } }
	val reach = state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation }
	LaunchedEffect(gatewayId, deviceId, reach) { open() }
	var menu by remember { mutableStateOf(false) }
	var removing by remember { mutableStateOf(false) }
	val display = displayUnitOf(assistantGateway(state)?.let { state.gateways.assistantOn(it) })

	AssistantPageScaffold(
		record?.name ?: "Device",
		onBack,
		actions = {
			IconButton(onClick = hapticClick { open() }) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
			if (record != null) {
				Box {
					IconButton(onClick = hapticClick { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More") }
					DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
						DropdownMenuItem(
							text = { Text("Remove device", color = MaterialTheme.colorScheme.error) },
							enabled = !view.busy(record.id),
							onClick = {
								menu = false
								removing = true
							},
						)
					}
				}
			}
		},
	) {
		val list = view.list
		when {
			record != null -> {
				val subtitle = if (record.isSensor()) {
					sensorSubtitle(record, view.sensorOf(record.id)?.read?.model, gatewayId, view.sensorOf(record.id), System.currentTimeMillis())
				} else {
					"${brandLine(record)} · $gatewayId"
				}
				Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				if (record.isSensor()) {
					sensorTrouble(view.sensorOf(record.id), System.currentTimeMillis())?.let {
						Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
					}
				}
				if (record.isSensor()) SensorBody(repo, gatewayId, record, view, display)
				else DeviceBody(repo, gatewayId, record, view, onRetry = { open() })
			}
			list is DeviceListView.Unavailable -> {
				Text(list.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
				if (list.retryable()) OutlinedButton(onClick = hapticClick { open() }) { Text("Retry") }
			}
			list == DeviceListView.Declined -> Text(GATEWAY_DECLINED, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			else -> CircularProgressIndicator()
		}
	}
	if (removing && record != null) {
		ConfirmDialog(
			title = "Remove ${record.name}?",
			body = if (record.isSensor()) {
				"Switchboard stops reading it, and its alerts go with it."
			} else {
				"Switchboard stops controlling it. Its own schedule stays on the device."
			},
			confirmText = "Remove",
			onConfirm = {
				removing = false
				repo.command { deviceOps.remove(gatewayId, record) }
			},
			onDismiss = { removing = false },
		)
	}
}

@Composable
internal fun RenameSection(repo: ChatRepository, gatewayId: String, record: DeviceRecord, busy: Boolean) {
	var name by rememberSaveable(record.id) { mutableStateOf(record.name) }
	OutlinedTextField(
		value = name,
		onValueChange = { name = it },
		label = { Text("Name") },
		singleLine = true,
		modifier = Modifier.fillMaxWidth(),
	)
	OutlinedButton(
		onClick = hapticClick { repo.command { deviceOps.rename(gatewayId, record, name.trim()) } },
		enabled = !busy && renameReady(name, record),
	) { Text("Rename") }
}

@Composable
private fun DeviceBody(repo: ChatRepository, gatewayId: String, record: DeviceRecord, view: DevicesView, onRetry: () -> Unit) {
	val live = view.liveOf(record.id)
	val detail = view.detailOf(record.id)
	val busy = view.busy(record.id)
	val capabilities = capabilitiesOf(record)
	val held = view.scheduleDraft(record.id)
	var picking by remember { mutableStateOf<Int?>(null) }
	var confirming by remember { mutableStateOf<IntegrationAct?>(null) }
	val draftEdit = { draft: ScheduleDraft -> repo.deviceOps.editDraft(gatewayId, record.id, draft) }
	val runAct = { act: IntegrationAct ->
		repo.command { deviceOps.putSetting(gatewayId, record, act.put) }
	}

	view.alert(record.id)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	if (DeviceCapability.SWITCH in capabilities) {
		Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
			Column(Modifier.weight(1f)) {
				Text("Power", style = MaterialTheme.typography.bodyLarge)
				liveLine(live)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
			}
			PowerControl(live, busy) { on -> repo.command { deviceOps.set(gatewayId, record.id, on) } }
		}
		HorizontalDivider()
	}

	RenameSection(repo, gatewayId, record, busy)

	HorizontalDivider()
	if (detail == null || held == null) {
		if (view.detailRetry(record.id)) {
			OutlinedButton(onClick = hapticClick(onRetry), enabled = !busy) { Text("Retry") }
		} else {
			CircularProgressIndicator()
		}
	} else {
		if (DeviceCapability.SCHEDULE in capabilities) {
			ScheduleSection(
				held,
				zone = (detail.settings as? DeviceSettings.Kasa)?.clock?.zone,
				busy = busy,
				savable = view.scheduleSavable(record.id),
				onDiscard = { repo.deviceOps.discardDraft(gatewayId, record.id) }.takeIf { view.editOf(record.id) != null },
				onChange = draftEdit,
				onPick = { picking = it },
				onSave = {
					val base = view.scheduleBase(record.id) ?: detail.schedule
					repo.command { deviceOps.putSchedule(gatewayId, record, base, held.toSchedule()) }
				},
			)
			HorizontalDivider()
		}
		ProviderSection(
			title = brandLine(record),
			capabilities = capabilities,
			acts = providerActs(record),
			settings = detail.settings,
			readAt = detail.readAt,
			busy = busy,
			onRetry = onRetry,
			onLed = { on -> repo.command { deviceOps.putSetting(gatewayId, record, DeviceSettingPut.Kasa(KasaSettingPut.Led(on))) } },
			onAct = { act -> if (act.tier == ActTier.DANGER) confirming = act else runAct(act) },
		)
	}

	picking?.let { index ->
		val rule = held?.rules?.getOrNull(index)
		if (rule != null) {
			ClockPickerDialog(
				time = rule.time,
				onPick = { time ->
					draftEdit(held.edited(index) { it.copy(time = time) })
					picking = null
				},
				onDismiss = { picking = null },
			)
		}
	}
	confirming?.let { act ->
		ConfirmDialog(
			title = "${act.label}?",
			body = act.confirm ?: "",
			confirmText = act.label.substringBefore(' '),
			onConfirm = {
				confirming = null
				runAct(act)
			},
			onDismiss = { confirming = null },
		)
	}
}

@Composable
private fun ScheduleSection(
	draft: ScheduleDraft,
	zone: String?,
	busy: Boolean,
	savable: Boolean,
	onDiscard: (() -> Unit)?,
	onChange: (ScheduleDraft) -> Unit,
	onPick: (Int) -> Unit,
	onSave: () -> Unit,
) {
	Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.weight(1f)) {
			Text("Schedule", style = MaterialTheme.typography.labelLarge)
			zone?.let {
				Text("Times on the plug's clock ($it)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		Switch(checked = draft.enabled, onCheckedChange = { onChange(draft.copy(enabled = it)) }, enabled = !busy)
	}
	draft.rules.forEachIndexed { index, rule ->
		Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(
					rule.time,
					style = MaterialTheme.typography.titleMedium,
					modifier = Modifier.clickable(enabled = !busy, onClick = hapticClick { onPick(index) }),
				)
				SingleChoiceSegmentedButtonRow(Modifier.width(128.dp)) {
					SCHEDULE_ACTIONS.forEachIndexed { at, (action, label) ->
						SegmentedButton(
							selected = rule.action == action,
							onClick = hapticClick { onChange(draft.withAction(index, action)) },
							shape = SegmentedButtonDefaults.itemShape(index = at, count = SCHEDULE_ACTIONS.size),
							enabled = !busy,
							icon = {},
						) { Text(label) }
					}
				}
				Text(daysText(rule.days), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
				Switch(
					checked = rule.enabled,
					onCheckedChange = { on -> onChange(draft.edited(index) { it.copy(enabled = on) }) },
					enabled = !busy,
				)
				IconButton(onClick = hapticClick { onChange(draft.removed(index)) }, enabled = !busy) {
					Icon(Icons.Default.Delete, contentDescription = "Remove rule")
				}
			}
			FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
				DAY_INITIALS.forEachIndexed { day, initial ->
					FilterChip(
						selected = rule.days.getOrElse(day) { false },
						onClick = hapticClick { onChange(draft.dayToggled(index, day)) },
						label = { Text(initial) },
						enabled = !busy,
					)
				}
			}
		}
	}
	Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		OutlinedButton(onClick = hapticClick { onChange(draft.added()) }, enabled = !busy && !draft.full) { Text("Add rule") }
		Button(onClick = hapticClick(onSave), enabled = savable) { Text("Save schedule") }
		onDiscard?.let { TextButton(onClick = hapticClick(it), enabled = !busy) { Text("Discard") } }
	}
}

/** The brand's section: one renderer per declared capability. */
@Composable
private fun ProviderSection(
	title: String,
	capabilities: List<DeviceCapability>,
	acts: List<IntegrationAct>,
	settings: DeviceSettings?,
	readAt: Long,
	busy: Boolean,
	onRetry: () -> Unit,
	onLed: (Boolean) -> Unit,
	onAct: (IntegrationAct) -> Unit,
) {
	val drawn = capabilities.filter { it != DeviceCapability.SWITCH && it != DeviceCapability.SCHEDULE }
	if (drawn.isEmpty()) return
	Text(title, style = MaterialTheme.typography.labelLarge)
	val kasa = settings as? DeviceSettings.Kasa
	if (kasa == null) {
		Text("Settings could not be read", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		OutlinedButton(onClick = hapticClick(onRetry), enabled = !busy) { Text("Retry") }
		return
	}
	for (capability in drawn) {
		when (capability) {
			DeviceCapability.SWITCH, DeviceCapability.SCHEDULE -> Unit
			DeviceCapability.LED -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
				Text("Status light", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
				Switch(checked = kasa.led, onCheckedChange = onLed, enabled = !busy)
			}
			DeviceCapability.CLOCK -> Text(
				clockLine(kasa.clock, readAt),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			DeviceCapability.CLOUD -> {
				val bound = kasa.cloud == Protocol.Wire.DeviceCloudState.BOUND
				Text(if (bound) "Cloud: connected" else "Cloud: disconnected; local only", style = MaterialTheme.typography.bodyMedium)
			}
		}
	}
	for (act in acts.filter { actOffered(it.key, settings) }) ActButton(act, busy) { onAct(act) }
}

@Composable
private fun ActButton(act: IntegrationAct, busy: Boolean, onClick: () -> Unit) {
	val colors = when (act.tier) {
		ActTier.ACT -> ButtonDefaults.outlinedButtonColors()
		ActTier.DANGER -> ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
	}
	OutlinedButton(onClick = hapticClick(onClick), enabled = !busy, colors = colors) { Text(act.label) }
}
