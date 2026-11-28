package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.FUNCTION_CHANGED_LINE
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.REACHES_HEADER
import com.atelier_nyaarium.switchboard.UNIQUE_LINE
import com.atelier_nyaarium.switchboard.FUNCTION_UNLISTED
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.runsIssueLine
import com.atelier_nyaarium.switchboard.runsNoteLine
import com.atelier_nyaarium.switchboard.paramIssueLine
import com.atelier_nyaarium.switchboard.typeWordText
import com.atelier_nyaarium.switchboard.usedByLine

internal val FUNCTION_MARK = Char(0x0192).toString()

/** The mark, the name, a count when shared. */
@Composable
internal fun FunctionName(name: String, count: Int?) {
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
		Text(FUNCTION_MARK, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
		Text(name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		count?.let { Text("$it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
	}
}

/** The function head, its parameters, who else it reaches. */
@Composable
internal fun RunsBlock(
	view: RunsView,
	offer: AutomationOffer,
	enabled: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	onReload: () -> Unit,
) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Text(FUNCTION_MARK, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
		if (view.unlisted) {
			Text(FUNCTION_UNLISTED, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = dim)
		} else {
			OutlinedTextField(
				value = view.name,
				onValueChange = { typed -> edit { it.withFunctionName(typed, offer.functions) } },
				placeholder = { Text("Name") },
				singleLine = true,
				enabled = enabled && view.nameEditable,
				modifier = Modifier.weight(1f),
			)
		}
		view.usedBy?.let { Text(usedByLine(it), style = MaterialTheme.typography.labelMedium, color = dim) }
		IconButton(onClick = hapticClick { edit { it.copy(picking = true) } }, enabled = enabled) {
			Icon(Icons.Default.ArrowDropDown, contentDescription = "Run another function")
		}
	}
	if (view.changed) {
		Column {
			Text(FUNCTION_CHANGED_LINE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			TextButton(onClick = hapticClick(onReload), enabled = enabled) { Text("Reload") }
		}
	}
	view.invalid?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	for (row in view.values) ValueRowView(row, offer, enabled, edit)
	if (canAddParam(view)) {
		TextButton(onClick = hapticClick { edit { it.plusFunctionParam() } }, enabled = enabled) { Text("+ Add parameter") }
	}
	if (view.makeUnique || view.unique) {
		OutlinedCard(Modifier.fillMaxWidth()) {
			Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
				if (view.unique) {
					Text(UNIQUE_LINE, style = MaterialTheme.typography.bodySmall, color = dim)
				} else {
					if (view.reachHeader) Text(REACHES_HEADER, style = MaterialTheme.typography.bodySmall, color = dim)
					for (sentence in view.reach) Text(sentence, style = MaterialTheme.typography.bodyMedium)
					TextButton(onClick = hapticClick { edit { it.madeUnique(offer) } }, enabled = enabled) { Text("Make unique") }
				}
			}
		}
	}
	view.issue?.let { Text(runsIssueLine(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	view.note?.let { Text(runsNoteLine(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	for (issue in view.issues) CardIssueLine(issue)
}

@Composable
private fun ValueRowView(row: ValueRow, offer: AutomationOffer, enabled: Boolean, edit: ((AutomationDraft) -> AutomationDraft) -> Unit) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	val param = row.param
	val name = row.name
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Column(Modifier.weight(0.4f)) {
			if (param == null) {
				Text(name, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
				Text(typeWordText(row.type), style = MaterialTheme.typography.labelSmall, color = dim)
			} else {
				OutlinedTextField(
					value = name,
					onValueChange = { typed -> edit { it.withFunctionParam(row.key.orEmpty(), param.copy(name = typed)) } },
					placeholder = { Text("name") },
					singleLine = true,
					isError = row.issue != null,
					enabled = enabled,
					modifier = Modifier.fillMaxWidth(),
				)
				PickMenu(
					label = "Type",
					choices = FunctionParamType.entries,
					picked = FunctionParamType.entries.find { it.wire == param.type },
					labelOf = { functionParamTypeText(it.wire) },
					onPick = { type -> edit { it.withFunctionParam(row.key.orEmpty(), param.copy(type = type.wire)) } },
					enabled = enabled,
				)
				IconButton(onClick = hapticClick { edit { it.withoutFunctionParam(row.key.orEmpty()) } }, enabled = enabled) {
					Icon(Icons.Default.Close, contentDescription = "Remove parameter")
				}
				row.issue?.let { Text(paramIssueLine(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
			}
		}
		Column(Modifier.weight(0.6f)) {
			val set = (row.source as? ValueSource.Set)?.text.orEmpty()
			when {
				row.source == ValueSource.FromTrigger -> Text("from the trigger", style = MaterialTheme.typography.bodySmall, color = dim)
				row.source is ValueSource.Mismatch -> Text(
					"Trigger gives ${typeWordText(TypeWord.Given(row.source.gets)).lowercase()}; needs ${row.source.wants}.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.error,
				)
				param == null -> Text("not given", style = MaterialTheme.typography.bodySmall, color = dim)
				param.type == FunctionParamType.DEVICE.wire -> PickMenu(
					label = "Device",
					choices = offer.devices,
					picked = offer.devices.find { it.device == set },
					labelOf = { it.name },
					onPick = { picked -> row.key?.let { key -> edit { it.withFunctionArg(key, picked.device) } } },
					enabled = enabled,
					placeholder = "Pick a device",
				)
				else -> OutlinedTextField(
					value = set,
					onValueChange = { typed -> row.key?.let { key -> edit { it.withFunctionArg(key, typed) } } },
					label = { Text(functionParamTypeText(param.type)) },
					singleLine = true,
					keyboardOptions = EXACT_KEYBOARD,
					enabled = enabled,
					modifier = Modifier.fillMaxWidth(),
				)
			}
		}
	}
	IssueLine(row.refused)
}

/** "Run a function": a fresh body, then what fits. */
@Composable
internal fun FunctionPicker(
	subtitle: String?,
	choices: List<PickerRow>,
	onBack: () -> Unit,
	onFresh: () -> Unit,
	onPick: (PickerRow) -> Unit,
) {
	AssistantPageScaffold("Run a function", onBack) {
		subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
		TextButton(onClick = hapticClick(onFresh)) { Text("+ New function") }
		HorizontalDivider()
		for (choice in choices) {
			val highlight = if (choice.current) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier
			Row(
				Modifier.fillMaxWidth().then(highlight).clickable(onClick = hapticClick { onPick(choice) }).padding(vertical = 8.dp),
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(8.dp),
			) {
				Text(FUNCTION_MARK, color = MaterialTheme.colorScheme.primary)
				Column(Modifier.weight(1f)) {
					Text(choice.function.function.name, style = MaterialTheme.typography.bodyLarge)
					Text(
						choice.signature.joinToString(", ", "(", ")") { (name, type) -> "$name: ${typeWordText(type)}" },
						style = MaterialTheme.typography.bodySmall,
						fontFamily = FontFamily.Monospace,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					choice.invalid?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
				}
				Text(
					"${choice.count}",
					style = MaterialTheme.typography.labelMedium,
					color = if (choice.current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
	}
}
