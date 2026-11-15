package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import com.atelier_nyaarium.switchboard.AutomationDraftKey
import com.atelier_nyaarium.switchboard.AutomationSaved
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.RemoveMenu
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.leaveShown
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.sourcesOf
import kotlinx.coroutines.delay

private const val PREVIEW_DEBOUNCE_MS = 400L

private val TRIGGER_KINDS = listOf("Event arrives", "Value crosses", "Time comes")
private val TELLS = listOf("now" to "Now", "quietly" to "Quietly")

@Composable
internal fun AutomationsPage(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	onEdit: (String, AutomationSlot) -> Unit,
	onBack: () -> Unit,
) {
	LaunchedEffect(state.gateways.incarnations()) { repo.automationOps.refreshAll() }
	val groups = automationGroups(state.gateways, home)
	val toggleRefusals by repo.automationOps.toggleRefusals

	AssistantPageScaffold(
		"Automations",
		onBack,
		actions = { if (home != null) Button(onClick = hapticClick { onEdit(home, AutomationSlot.New) }) { Text("New") } },
	) {
		if (groups.isEmpty()) {
			Text("No automations", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		for (group in groups) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(group.gatewayId, style = MaterialTheme.typography.labelLarge)
				if (group.assistant) AssistantChip()
			}
			for (row in group.rows) {
				AutomationRowView(
					row = row,
					can = group.edits(row),
					refusal = toggleRefusals[group.gatewayId to row.id],
					onOpen = { onEdit(group.gatewayId, AutomationSlot.Held(row.id)) },
					onToggle = { on -> repo.command { automationOps.setEnabled(group.gatewayId, row, on) } },
				)
			}
		}
	}
}

@Composable
private fun AutomationRowView(row: AutomationRow, can: Boolean, refusal: String?, onOpen: () -> Unit, onToggle: (Boolean) -> Unit) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	Row(
		Modifier.fillMaxWidth().clickable(enabled = can, onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(row.sentence, style = MaterialTheme.typography.bodyLarge)
			Text(doesText(row.automation), style = MaterialTheme.typography.bodySmall, color = dim)
			Text(
				row.invalid ?: ranText(row, ::agoText),
				style = MaterialTheme.typography.bodySmall,
				color = if (row.invalid != null) MaterialTheme.colorScheme.error else dim,
			)
			refusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		Switch(checked = row.automation.enabled, onCheckedChange = onToggle, enabled = can)
	}
}

/** Drafts outlive this page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AutomationEditorPage(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	slot: AutomationSlot,
	onClose: () -> Unit,
	onBack: () -> Unit,
) {
	val ops = repo.automationOps
	val key = AutomationDraftKey(gatewayId, slot)
	val sources = state.gateways.assistantOn(gatewayId)?.let(::sourcesOf).orEmpty()
	val listed = state.gateways.entry(gatewayId)?.automations != null
	val row = (slot as? AutomationSlot.Held)?.let { state.gateways.automationOn(gatewayId, it.id) }
	val drafts by ops.drafts.collectAsState()
	val landed by ops.landed.collectAsState()
	val leaving by ops.leaving.collectAsState()
	val held = drafts[key]
	var shown by remember(key) { mutableStateOf<Long?>(null) }
	val opened = remember(key, row, sources.isEmpty()) { openedDraft(slot, row, sources) }
	LaunchedEffect(key, opened) { if (shown == null && opened != null) shown = ops.hold(key, opened) }
	LaunchedEffect(shown, landed[key]) { if (editorLanded(shown, landed[key])) onClose() }
	LaunchedEffect(gatewayId) { ops.refresh(gatewayId) }
	// Closing; nothing to draw.
	if (editorLanded(shown, landed[key])) return
	val draft = held?.draft ?: opened

	if (draft == null) {
		AssistantPageScaffold("Automation", onBack) {
			when {
				slot == AutomationSlot.New -> Text("No source can trigger an automation.", style = MaterialTheme.typography.bodyLarge)
				listed -> Text("This automation is not edited here.", style = MaterialTheme.typography.bodyLarge)
				else -> CircularProgressIndicator()
			}
		}
		return
	}

	val fields = SourceFields(sources.find { it.id == draft.source }?.fieldSpecs.orEmpty())
	val choices = sourceChoices(sources, draft.source)
	val offered = sources.any { it.id == draft.source && it.triggers }
	val gone = slot is AutomationSlot.Held && listed && row == null
	val busy = held?.busy == true
	val can = automationEditing(slot, draft, fields, offered, busy, gone)
	val trigger = fittingAutomation(draft, fields)?.trigger?.takeIf { offered }
	var preview by remember(key) { mutableStateOf<ConsoleAutomationPreviewResult?>(null) }
	var previewFailed by remember(key) { mutableStateOf(false) }
	var previewOpen by rememberSaveable(key) { mutableStateOf(false) }
	var confirmingDelete by remember(key) { mutableStateOf(false) }

	LaunchedEffect(trigger) {
		preview = null
		previewFailed = false
		val asked = trigger ?: return@LaunchedEffect
		delay(PREVIEW_DEBOUNCE_MS)
		preview = ops.preview(gatewayId, asked)
		previewFailed = preview == null
	}

	fun send(deleting: Boolean, op: suspend (AutomationDraft) -> AutomationSaved) {
		repo.command { automationOps.send(key, deleting, op) }
	}

	AssistantPageScaffold(
		if (gone) "Deleted elsewhere" else "Automation",
		onBack,
		actions = {
			Button(
				enabled = can.save,
				onClick = hapticClick {
					send(deleting = false) { sent ->
						fittingAutomation(sent, fields)?.let { ops.save(gatewayId, sent.id, it, sent.revision) }
							?: AutomationSaved.Refused("Not a complete automation")
					}
				},
				modifier = Modifier.padding(end = 8.dp),
			) { Text(if (busy) "Saving" else "Save") }
			if (slot is AutomationSlot.Held) RemoveMenu("Delete automation", enabled = can.delete) { confirmingDelete = true }
		},
	) {
		Text("When", style = MaterialTheme.typography.labelLarge)
		SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
			TRIGGER_KINDS.forEachIndexed { index, label ->
				SegmentedButton(
					selected = index == 0,
					onClick = {},
					enabled = index == 0,
					shape = SegmentedButtonDefaults.itemShape(index = index, count = TRIGGER_KINDS.size),
					icon = {},
				) { Text(label, maxLines = 1) }
			}
		}
		PickMenu(
			label = "Source",
			choices = choices,
			picked = draft.source.takeIf { it.isNotBlank() },
			labelOf = { id -> sources.find { it.id == id }?.label ?: id },
			onPick = { id -> if (id != draft.source) ops.edit(key, draft.withSource(id)) },
			trailingOf = { id -> "not offered".takeUnless { sources.any { it.id == id && it.triggers } } },
			enabled = can.edit,
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
						onPick = { field -> ops.edit(key, draft.withField(index, field, fields)) },
						enabled = can.edit,
					)
				}
				Box(Modifier.weight(0.7f)) {
					PickMenu(
						label = "Test",
						choices = testsOf(fields.specOf(condition.field)),
						picked = condition.test,
						labelOf = ::testLabel,
						onPick = { test -> ops.edit(key, draft.changed(index) { it.copy(test = test) }) },
						enabled = can.edit,
					)
				}
				IconButton(onClick = hapticClick { ops.edit(key, draft.withoutCondition(index)) }, enabled = can.edit) {
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
					onPick = { value -> ops.edit(key, draft.changed(index) { it.copy(value = value) }) },
					trailingOf = { value -> "not offered".takeUnless { fields.offers(condition.field, value) } },
					enabled = can.edit,
				)
			} else {
				OutlinedTextField(
					value = condition.value,
					onValueChange = { value -> ops.edit(key, draft.changed(index) { it.copy(value = value) }) },
					label = { Text("Value") },
					singleLine = true,
					enabled = can.edit,
					modifier = Modifier.fillMaxWidth(),
				)
			}
			fields.issueOf(condition)?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			}
		}
		if (draft.conditions.size < MAX_CONDITIONS && fields.ruleFields.isNotEmpty()) {
			TextButton(onClick = hapticClick { ops.edit(key, draft.withCondition(fields)) }, enabled = can.edit) {
				Text("+ Add condition")
			}
		}
		PreviewFold(preview, previewFailed, previewOpen) { previewOpen = !previewOpen }

		HorizontalDivider()
		Text("Do", style = MaterialTheme.typography.labelLarge)
		Text("Tell the assistant", style = MaterialTheme.typography.bodyMedium)
		SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
			TELLS.forEachIndexed { index, (value, label) ->
				SegmentedButton(
					selected = draft.tell == value,
					onClick = hapticClick { ops.edit(key, draft.copy(tell = value)) },
					enabled = can.edit,
					shape = SegmentedButtonDefaults.itemShape(index = index, count = TELLS.size),
					icon = {},
				) { Text(label) }
			}
		}
		held?.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	}

	if (confirmingDelete) {
		ConfirmDialog(
			title = "Delete this automation?",
			body = null,
			confirmText = "Delete",
			onConfirm = {
				confirmingDelete = false
				send(deleting = true) { sent -> ops.delete(gatewayId, sent.id, sent.revision) }
			},
			onDismiss = { confirmingDelete = false },
		)
	}

	if (leaveShown(leaving, key, held)) {
		AlertDialog(
			onDismissRequest = { ops.stay() },
			title = { Text("Leave and discard changes?") },
			text = { Text("Changes have not been saved.") },
			confirmButton = { TextButton(onClick = hapticClick { ops.stay() }) { Text("Stay") } },
			dismissButton = {
				TextButton(
					onClick = hapticClick {
						ops.discard(key)
						onClose()
					},
				) { Text("Discard", color = MaterialTheme.colorScheme.error) }
			},
		)
	}
}

@Composable
private fun PreviewFold(preview: ConsoleAutomationPreviewResult?, failed: Boolean, open: Boolean, onToggle: () -> Unit) {
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
