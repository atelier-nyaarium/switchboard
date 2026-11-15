package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AutomationDraftKey
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.ShownEditor
import com.atelier_nyaarium.switchboard.assistantGateway
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.extremesLine
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.payloadView
import com.atelier_nyaarium.switchboard.readingText
import com.atelier_nyaarium.switchboard.saidOf
import com.atelier_nyaarium.switchboard.sensorOf
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val CLOCK = DateTimeFormatter.ofPattern("HH:mm")
private val SECONDS = DateTimeFormatter.ofPattern("HH:mm:ss")

private fun clockAt(at: Long): String = CLOCK.format(Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()))

@Composable
internal fun SensorBody(repo: ChatRepository, state: ChatState, gatewayId: String, record: DeviceRecord, view: DevicesView, display: String?) {
	val held = view.sensorOf(record.id)
	val read = held?.read
	val busy = view.busy(record.id)

	view.saidOf(record.id)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	if (read == null) {
		if (held?.failed == null) CircularProgressIndicator()
	} else if (read.readings.isNotEmpty()) {
		Text("Readings", style = MaterialTheme.typography.labelLarge)
		for (reading in read.readings) {
			Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(reading.spec.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
					Text(readingText(reading, display) ?: "No value", style = MaterialTheme.typography.bodyLarge)
				}
				extremesLine(reading, display, ::clockAt)?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
	}
	HorizontalDivider()
	WatchingSection(repo, state, gatewayId, record.id)
	if (read != null && record.definition == null) {
		HorizontalDivider()
		RawSection(read, gatewayId)
	}
	HorizontalDivider()
	RenameSection(repo, gatewayId, record, busy)
}

@Composable
private fun WatchingSection(repo: ChatRepository, state: ChatState, gatewayId: String, deviceId: String) {
	LaunchedEffect(gatewayId) { repo.automationOps.refresh(gatewayId) }
	val home = assistantGateway(state)
	val entry = state.gateways.entry(gatewayId)
	val offer = offerOn(entry, away = gatewayId != home)
	val uses = usedBy(gatewayId, entry?.automations) { watching(deviceId, it) }
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	val open = { slot: AutomationSlot -> repo.editors.show(ShownEditor.Automation(AutomationDraftKey(gatewayId, slot))) }

	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text("Automations", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
		if (offersWatch(deviceId, offer)) {
			TextButton(onClick = hapticClick { open(AutomationSlot.New(watch = deviceId)) }) { Text("New") }
		}
	}
	when (uses) {
		is UsedBy.Empty -> {
			val line = watchingEmptyLine(uses.why)
			if (line == null) CircularProgressIndicator() else Text(line, style = MaterialTheme.typography.bodySmall, color = dim)
		}
		is UsedBy.Rows -> for (row in uses.rows) {
			val on = row.automation.enabled
			Column(
				Modifier.fillMaxWidth()
					.clickable(enabled = editable(row, offer), onClick = hapticClick { open(AutomationSlot.Held(row.id)) })
					.padding(vertical = 6.dp),
				verticalArrangement = Arrangement.spacedBy(2.dp),
			) {
				Text(row.sentence, style = MaterialTheme.typography.bodyLarge, color = if (on) Color.Unspecified else dim)
				Text(doesText(row.automation, offer), style = MaterialTheme.typography.bodySmall, color = dim)
			}
		}
	}
}

@Composable
private fun RawSection(read: ConsoleDeviceReadResult.Sensor, gatewayId: String) {
	val raw = payloadView(read.payloads.orEmpty(), gatewayId)
	Text("Raw", style = MaterialTheme.typography.labelLarge)
	if (raw == null) {
		Text("Nothing heard yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		return
	}
	Text(
		"Maker data ${raw.company} · last ${raw.rows.size} distinct",
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
	for (row in raw.rows) {
		Column(Modifier.padding(vertical = 4.dp)) {
			Text("${SECONDS.format(Instant.ofEpochMilli(row.at).atZone(ZoneId.systemDefault()))} · ${row.radio}", style = MaterialTheme.typography.bodySmall)
			Text(
				buildAnnotatedString {
					row.bytes.forEachIndexed { at, byte ->
						if (at > 0) append(" ")
						if (row.changed[at]) withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)) { append(byte) }
						else append(byte)
					}
				},
				fontFamily = FontFamily.Monospace,
				style = MaterialTheme.typography.bodyMedium,
			)
			Text(
				row.bytes.indices.joinToString(" ") { it.toString().padEnd(2) },
				fontFamily = FontFamily.Monospace,
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}
