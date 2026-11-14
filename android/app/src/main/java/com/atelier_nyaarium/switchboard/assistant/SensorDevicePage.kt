package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AlertRow
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.ThresholdEdit
import com.atelier_nyaarium.switchboard.alertBlocks
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.deadZoneEdit
import com.atelier_nyaarium.switchboard.extremesLine
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.payloadView
import com.atelier_nyaarium.switchboard.readingText
import com.atelier_nyaarium.switchboard.saidOf
import com.atelier_nyaarium.switchboard.sensorOf
import com.atelier_nyaarium.switchboard.sideCleared
import com.atelier_nyaarium.switchboard.sideEdit
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val CLOCK = DateTimeFormatter.ofPattern("HH:mm")
private val SECONDS = DateTimeFormatter.ofPattern("HH:mm:ss")

private fun clockAt(at: Long): String = CLOCK.format(Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()))

/** Keeps its opening unit. */
private sealed interface Editing {
	val display: String?

	data class Side(val row: AlertRow, override val display: String?) : Editing

	data class DeadZone(val measure: String, val suffix: String, override val display: String?) : Editing
}

@Composable
internal fun SensorBody(repo: ChatRepository, gatewayId: String, record: DeviceRecord, view: DevicesView, display: String?) {
	val held = view.sensorOf(record.id)
	val read = held?.read
	val busy = view.busy(record.id)
	var editing by remember { mutableStateOf<Editing?>(null) }

	view.saidOf(record.id)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	if (read == null) {
		if (held?.failed == null) CircularProgressIndicator()
	} else {
		if (read.readings.isNotEmpty()) {
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
			HorizontalDivider()
		}
		AlertsSection(read, display, busy, onEdit = { editing = it }) { row ->
			sideCleared(record.id, read, row)?.let { put -> repo.command { deviceOps.putThreshold(gatewayId, put) } }
		}
		if (record.definition == null) RawSection(read, gatewayId)
	}
	HorizontalDivider()
	RenameSection(repo, gatewayId, record, busy)

	editing?.let { target ->
		val current = read ?: return@let
		val (title, edit) = when (target) {
			is Editing.Side -> target.row.label to { text: String -> sideEdit(record.id, current, target.row, text, target.display) }
			is Editing.DeadZone -> "Dead zone" to { text: String -> deadZoneEdit(record.id, current, target.measure, text, target.display) }
		}
		ValueDialog(
			title = title,
			suffix = when (target) {
				is Editing.Side -> target.row.suffix
				is Editing.DeadZone -> target.suffix
			},
			initial = (target as? Editing.Side)?.row?.value.orEmpty(),
			onSave = { text ->
				when (val result = edit(text)) {
					is ThresholdEdit.Issue -> result.line
					is ThresholdEdit.Put -> {
						editing = null
						repo.command { deviceOps.putThreshold(gatewayId, result.put) }
						null
					}
				}
			},
			onDismiss = { editing = null },
		)
	}
}

@Composable
private fun AlertsSection(
	read: ConsoleDeviceReadResult.Sensor,
	display: String?,
	busy: Boolean,
	onEdit: (Editing) -> Unit,
	onClear: (AlertRow) -> Unit,
) {
	val blocks = alertBlocks(read, display)
	if (blocks.isEmpty()) return
	Text("Alerts", style = MaterialTheme.typography.labelLarge)
	for (block in blocks) {
		for (row in block.rows) {
			Row(
				Modifier.fillMaxWidth().clickable(enabled = !busy, onClick = hapticClick { onEdit(Editing.Side(row, display)) }).padding(vertical = 4.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text(row.label, style = MaterialTheme.typography.bodyLarge)
					row.value?.let { Text(it + row.suffix, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
				}
				Switch(
					checked = row.on,
					onCheckedChange = { on -> if (on) onEdit(Editing.Side(row, display)) else onClear(row) },
					enabled = !busy,
				)
			}
		}
		block.deadZone?.let { width ->
			Row(
				Modifier.fillMaxWidth()
					.clickable(enabled = !busy, onClick = hapticClick { onEdit(Editing.DeadZone(block.rows.first().measure, block.rows.first().suffix, display)) })
					.padding(vertical = 4.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text("Dead zone", style = MaterialTheme.typography.bodyLarge)
					Text(
						"How far back before it can alert again",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				Text(width, style = MaterialTheme.typography.bodyLarge)
			}
		}
	}
	Text("Alerts go to the assistant's inbox.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Null closes; issues remain. */
@Composable
private fun ValueDialog(title: String, suffix: String, initial: String, onSave: (String) -> String?, onDismiss: () -> Unit) {
	var text by remember { mutableStateOf(initial) }
	var issue by remember { mutableStateOf<String?>(null) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = {
			OutlinedTextField(
				value = text,
				onValueChange = {
					text = it
					issue = null
				},
				singleLine = true,
				isError = issue != null,
				suffix = { Text(suffix.trim()) },
				supportingText = issue?.let { line -> { Text(line) } },
				keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
			)
		},
		confirmButton = { TextButton(onClick = hapticClick { issue = onSave(text) }) { Text("Save") } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
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
