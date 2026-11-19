package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ClockPickerDialog
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult

private val NUMBER_KEYS = KeyboardOptions(keyboardType = KeyboardType.Decimal)
private val COUNT_KEYS = KeyboardOptions(keyboardType = KeyboardType.Number)

/** Mutually exclusive choices. */
@Composable
internal fun <T> ChoiceRow(choices: List<T>, picked: T?, labelOf: (T) -> String, enabledOf: (T) -> Boolean, onPick: (T) -> Unit) {
	SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
		choices.forEachIndexed { index, choice ->
			SegmentedButton(
				selected = choice == picked,
				onClick = hapticClick { onPick(choice) },
				enabled = enabledOf(choice),
				shape = SegmentedButtonDefaults.itemShape(index = index, count = choices.size),
				icon = {},
			) { Text(labelOf(choice), maxLines = 1) }
		}
	}
}

@Composable
internal fun IssueLine(line: String?) {
	line?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
}

@Composable
internal fun TriggerSection(
	draft: AutomationDraft,
	offer: AutomationOffer,
	sources: List<AssistantSource>,
	fields: SourceFields,
	zone: String,
	enabled: Boolean,
	read: PreviewRead,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val firstSource = sources.firstOrNull { it.triggers }?.id
	ChoiceRow(
		choices = TriggerChoice.entries,
		picked = choiceOf(draft.trigger),
		labelOf = { it.label },
		enabledOf = { enabled && offersChoice(offer, it, firstSource != null) },
		onPick = { choice -> edit { it.swapped(choice.kinds) { freshTrigger(choice, offer, firstSource, zone) } } },
	)
	when (val trigger = draft.trigger) {
		is TriggerDraft.Event -> EventForm(draft, sources, fields, enabled, read, edit)
		is TriggerDraft.Crossing -> CrossingForm(trigger, offer, draft.display, enabled, edit)
		is TriggerDraft.Time, is TriggerDraft.Interval -> ClockForm(trigger, offer, zone, enabled, edit)
	}
	IssueLine(triggerHint(draft.trigger, offer).takeUnless { draft.trigger is TriggerDraft.Event })
}

@Composable
private fun EventForm(
	draft: AutomationDraft,
	sources: List<AssistantSource>,
	fields: SourceFields,
	enabled: Boolean,
	read: PreviewRead,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	PickMenu(
		label = "Source",
		choices = sourceChoices(sources, draft.source),
		picked = draft.source.takeIf { it.isNotBlank() },
		labelOf = { id -> sources.find { it.id == id }?.label ?: id },
		onPick = { id -> if (id != draft.source) edit { it.withSource(id) } },
		trailingOf = { id -> "not offered".takeUnless { sources.any { it.id == id && it.triggers } } },
		enabled = enabled,
	)
	draft.conditions.forEachIndexed { index, condition ->
		if (index > 0) {
			Text("and", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.weight(1f)) {
				PickMenu(
					label = "Field",
					choices = fields.ruleFields,
					picked = condition.field,
					labelOf = fields::fieldLabelOf,
					onPick = { field -> edit { it.withField(index, field, fields) } },
					enabled = enabled,
				)
			}
			Box(Modifier.weight(0.7f)) {
				PickMenu(
					label = "Test",
					choices = testsOf(fields.specOf(condition.field)),
					picked = condition.test,
					labelOf = ::testLabel,
					onPick = { test -> edit { now -> now.changed(index) { it.copy(test = test) } } },
					enabled = enabled,
				)
			}
			IconButton(onClick = hapticClick { edit { it.withoutCondition(index) } }, enabled = enabled) {
				Icon(Icons.Default.Close, contentDescription = "Remove condition")
			}
		}
		val values = fields.choicesFor(condition.field, condition.value)
		if (values != null) {
			PickMenu(
				label = "Value",
				choices = values,
				picked = condition.value.takeIf { trimRuleValue(it).isNotEmpty() },
				labelOf = { value -> fields.valueLabelOf(condition.field, value) },
				onPick = { value -> edit { now -> now.changed(index) { it.copy(value = value) } } },
				trailingOf = { value -> "not offered".takeUnless { fields.offers(condition.field, value) } },
				enabled = enabled,
			)
		} else {
			OutlinedTextField(
				value = condition.value,
				onValueChange = { value -> edit { now -> now.changed(index) { it.copy(value = value) } } },
				label = { Text("Value") },
				singleLine = true,
				keyboardOptions = EXACT_KEYBOARD,
				enabled = enabled,
				modifier = Modifier.fillMaxWidth(),
			)
		}
		IssueLine(fields.issueOf(condition))
	}
	if (draft.conditions.size < MAX_CONDITIONS && fields.ruleFields.isNotEmpty()) {
		TextButton(onClick = hapticClick { edit { it.withCondition(fields) } }, enabled = enabled) {
			Text("+ Add condition")
		}
	}
	var open by rememberSaveable(draft.id) { mutableStateOf(false) }
	MatchesFold(read.answer, read.failed, open) { open = !open }
}

@Composable
private fun CrossingForm(
	trigger: TriggerDraft.Crossing,
	offer: AutomationOffer,
	display: String?,
	enabled: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val number = offer.number(trigger.device, trigger.measure)
	val suffix = crossingSuffix(trigger.unit, number?.unit, display).trim()
	PickMenu(
		label = "Value",
		choices = offer.numbers,
		picked = number,
		labelOf = { it.label },
		onPick = { picked -> edit { it.onCrossing { held -> held.picked(picked, offer, display) } } },
		enabled = enabled,
	)
	ChoiceRow(
		choices = DIRECTIONS,
		picked = DIRECTIONS.find { it.first == trigger.direction },
		labelOf = { it.second },
		enabledOf = { enabled },
		onPick = { picked -> edit { it.onCrossing { held -> held.copy(direction = picked.first) } } },
	)
	Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		OutlinedTextField(
			value = trigger.threshold,
			onValueChange = { typed -> edit { it.onCrossing { held -> held.copy(threshold = typed) } } },
			label = { Text("Threshold") },
			suffix = { Text(suffix) },
			singleLine = true,
			enabled = enabled,
			keyboardOptions = NUMBER_KEYS,
			modifier = Modifier.weight(1f),
		)
		OutlinedTextField(
			value = trigger.deadZone,
			onValueChange = { typed -> edit { it.onCrossing { held -> held.copy(deadZone = typed) } } },
			label = { Text("Dead zone") },
			suffix = { Text(suffix) },
			singleLine = true,
			enabled = enabled,
			keyboardOptions = NUMBER_KEYS,
			modifier = Modifier.weight(1f),
		)
	}
	OutlinedTextField(
		value = trigger.coolDownMin,
		onValueChange = { typed -> edit { it.onCrossing { held -> held.copy(coolDownMin = typed) } } },
		label = { Text("Cool-down") },
		suffix = { Text("min") },
		singleLine = true,
		enabled = enabled,
		keyboardOptions = NUMBER_KEYS,
		modifier = Modifier.fillMaxWidth(),
	)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ClockForm(
	trigger: TriggerDraft,
	offer: AutomationOffer,
	zone: String,
	enabled: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val kinds = clockKinds(offer)
	if (kinds.size > 1) {
		ChoiceRow(
			choices = kinds,
			picked = trigger.kind,
			labelOf = { CLOCK_KINDS.getValue(it) },
			enabledOf = { enabled },
			onPick = { kind -> edit { it.swapped(setOf(kind)) { freshClock(kind, zone) } } },
		)
	}
	when (trigger) {
		is TriggerDraft.Time -> {
			var picking by remember { mutableStateOf(false) }
			Box {
				OutlinedTextField(
					value = trigger.time,
					onValueChange = {},
					readOnly = true,
					enabled = enabled,
					label = { Text("Time") },
					supportingText = { Text(trigger.zone) },
					modifier = Modifier.fillMaxWidth(),
				)
				Box(Modifier.matchParentSize().clickable(enabled = enabled, onClick = hapticClick { picking = true }))
			}
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				WEEKDAY_LABELS.forEachIndexed { index, label ->
					val day = index + 1
					FilterChip(
						selected = day in trigger.weekdays,
						enabled = enabled,
						onClick = hapticClick {
							edit { it.onTime { held -> held.copy(weekdays = toggled(held.weekdays, day)) } }
						},
						label = { Text(label) },
					)
				}
			}
			if (picking) {
				ClockPickerDialog(
					time = trigger.time,
					onPick = { time ->
						edit { it.onTime { held -> held.copy(time = time) } }
						picking = false
					},
					onDismiss = { picking = false },
				)
			}
		}
		is TriggerDraft.Interval -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			OutlinedTextField(
				value = trigger.every,
				onValueChange = { typed -> edit { it.onInterval { held -> held.copy(every = typed) } } },
				label = { Text("Every") },
				singleLine = true,
				enabled = enabled,
				keyboardOptions = COUNT_KEYS,
				modifier = Modifier.weight(1f),
			)
			Box(Modifier.weight(1f)) {
				PickMenu(
					label = "Unit",
					choices = IntervalUnit.entries,
					picked = trigger.unit,
					labelOf = { it.label },
					onPick = { unit -> edit { it.onInterval { held -> held.copy(unit = unit) } } },
					enabled = enabled,
				)
			}
		}
		is TriggerDraft.Event, is TriggerDraft.Crossing -> Unit
	}
}

@Composable
private fun MatchesFold(preview: ConsoleAutomationPreviewResult?, failed: Boolean, open: Boolean, onToggle: () -> Unit) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	if (failed) {
		Text("Could not check recent events.", style = MaterialTheme.typography.bodySmall, color = dim)
		return
	}
	val shown = preview ?: return
	val head = previewHead(shown)
	if (head == null) {
		Text("No recent events.", style = MaterialTheme.typography.bodySmall, color = dim)
		return
	}
	FoldRow(head, open, onToggle)
	if (open) {
		for (match in shown.matches) {
			Row(Modifier.fillMaxWidth().padding(start = 26.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(match.title, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1)
				Text(agoText(match.at), style = MaterialTheme.typography.bodySmall, color = dim)
			}
		}
	}
}
