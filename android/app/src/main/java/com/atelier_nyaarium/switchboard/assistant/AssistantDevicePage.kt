package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import com.atelier_nyaarium.switchboard.alert
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.detailOf
import com.atelier_nyaarium.switchboard.detailRetry
import com.atelier_nyaarium.switchboard.editOf
import com.atelier_nyaarium.switchboard.liveOf
import com.atelier_nyaarium.switchboard.ScheduleDraft
import com.atelier_nyaarium.switchboard.clockLine
import com.atelier_nyaarium.switchboard.daysText
import com.atelier_nyaarium.switchboard.deviceRecord
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.liveLine
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.KasaSettingPut
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.renameReady
import com.atelier_nyaarium.switchboard.retryable
import com.atelier_nyaarium.switchboard.scheduleDraft
import com.atelier_nyaarium.switchboard.scheduleBase
import com.atelier_nyaarium.switchboard.scheduleSavable

private val SCHEDULE_ACTIONS = listOf(
	Protocol.Wire.DeviceScheduleAction.ON to "On",
	Protocol.Wire.DeviceScheduleAction.OFF to "Off",
)

internal const val CLOUD_DISCONNECT_BODY =
	"The Kasa app, Alexa and Google lose access. Switchboard keeps local control. " +
		"To undo, set the plug up again in the Kasa app."

/** One plug's controls. */
@Composable
internal fun AssistantDevicePage(repo: ChatRepository, gatewayId: String, deviceId: String, onBack: () -> Unit) {
	val views by repo.deviceOps.views.collectAsState()
	val state by repo.state.collectAsState()
	val view = views[gatewayId] ?: DevicesView()
	val record = deviceRecord(view, deviceId)
	val open = { repo.command { deviceOps.open(gatewayId, deviceId) } }
	val reach = state.gateways.entry(gatewayId)?.let { state.gateways.reachable(gatewayId) to it.incarnation }
	LaunchedEffect(gatewayId, deviceId, reach) { open() }

	AssistantPageScaffold(
		record?.name ?: "Plug",
		onBack,
		actions = {
			IconButton(onClick = hapticClick { open() }) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
		},
	) {
		val list = view.list
		when {
			record != null -> DeviceBody(repo, gatewayId, record, view, onRetry = { open() })
			list is DeviceListView.Unavailable -> {
				Text(list.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
				if (list.retryable()) OutlinedButton(onClick = hapticClick { open() }) { Text("Retry") }
			}
			else -> CircularProgressIndicator()
		}
	}
}

@Composable
private fun DeviceBody(repo: ChatRepository, gatewayId: String, record: DeviceRecord, view: DevicesView, onRetry: () -> Unit) {
	val live = view.liveOf(record.id)
	val detail = view.detailOf(record.id)
	val busy = view.busy(record.id)
	var name by rememberSaveable(record.id) { mutableStateOf(record.name) }
	val held = view.scheduleDraft(record.id)
	var picking by remember { mutableStateOf<Int?>(null) }
	var disconnecting by remember { mutableStateOf(false) }
	var removing by remember { mutableStateOf(false) }
	val draftEdit = { draft: ScheduleDraft -> repo.deviceOps.editDraft(gatewayId, record.id, draft) }

	view.alert(record.id)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.weight(1f)) {
			Text("Power", style = MaterialTheme.typography.bodyLarge)
			Text(liveLine(live), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		PowerControl(live, busy) { on -> repo.command { deviceOps.set(gatewayId, record.id, on) } }
	}

	HorizontalDivider()
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

	HorizontalDivider()
	if (detail == null || held == null) {
		if (view.detailRetry(record.id)) {
			OutlinedButton(onClick = hapticClick(onRetry), enabled = !busy) { Text("Retry") }
		} else {
			CircularProgressIndicator()
		}
	} else {
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
		when (val settings = detail.settings) {
			null -> {
				Text("Plug settings could not be read", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
				OutlinedButton(onClick = hapticClick(onRetry), enabled = !busy) { Text("Retry") }
			}
			is DeviceSettings.Kasa -> KasaSettings(
				settings,
				readAt = detail.readAt,
				busy = busy,
				onLed = { on ->
					repo.command { deviceOps.putSetting(gatewayId, record, DeviceSettingPut.Kasa(KasaSettingPut.Led(on))) }
				},
				onDisconnect = { disconnecting = true },
			)
		}
	}

	HorizontalDivider()
	TextButton(onClick = hapticClick { removing = true }, enabled = !busy) { Text("Remove plug") }

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
	if (disconnecting) {
		ConfirmDialog(
			title = "Disconnect from the Kasa cloud?",
			body = CLOUD_DISCONNECT_BODY,
			confirmText = "Disconnect",
			onConfirm = {
				disconnecting = false
				val put = DeviceSettingPut.Kasa(KasaSettingPut.Cloud(Protocol.Wire.DeviceCloudState.DISCONNECTED))
				repo.command { deviceOps.putSetting(gatewayId, record, put) }
			},
			onDismiss = { disconnecting = false },
		)
	}
	if (removing) {
		ConfirmDialog(
			title = "Remove ${record.name}?",
			body = "Switchboard stops controlling this plug. Its own schedule stays on the plug.",
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

@Composable
private fun KasaSettings(
	settings: DeviceSettings.Kasa,
	readAt: Long,
	busy: Boolean,
	onLed: (Boolean) -> Unit,
	onDisconnect: () -> Unit,
) {
	Text("Plug settings", style = MaterialTheme.typography.labelLarge)
	Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
		Text("Status light", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
		Switch(checked = settings.led, onCheckedChange = onLed, enabled = !busy)
	}
	Text(
		clockLine(settings.clock, readAt),
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	if (settings.cloud == Protocol.Wire.DeviceCloudState.BOUND) {
		Text("Kasa cloud: connected", style = MaterialTheme.typography.bodyMedium)
		OutlinedButton(onClick = hapticClick(onDisconnect), enabled = !busy) { Text("Disconnect from the cloud") }
	} else {
		Text("Kasa cloud: disconnected; local only", style = MaterialTheme.typography.bodyMedium)
	}
}
