package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.RuleDraftKey
import com.atelier_nyaarium.switchboard.RuleSaved
import com.atelier_nyaarium.switchboard.WorkKey
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import kotlinx.coroutines.delay

private const val PREVIEW_DEBOUNCE_MS = 400L

/** Rule order determines matches. */
@Composable
internal fun WatcherRulesPage(
	repo: ChatRepository,
	gatewayId: String,
	watcher: AssistantWatcher,
	onEdit: (RuleSlot) -> Unit,
	onBack: () -> Unit,
) {
	val ops = repo.assistantOps
	val rules = rulesOf(watcher) ?: return
	val works by ops.work.collectAsState()
	val workKey = WorkKey.RuleList(gatewayId, watcher.id)
	val busy = works[workKey]?.busy == true

	AssistantPageScaffold(watcher.label, onBack) {
		Text(
			"Stops on first match.",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		rules.held.rules.forEachIndexed { index, rule ->
			val before = raisedBefore(rules.held, rule.id)?.takeIf { !busy }
			RuleRow(
				number = "${index + 1}",
				text = rules.summary(rule),
				invalid = rules.invalid[rule.id],
				action = rule.action,
				onOpen = { onEdit(RuleSlot.Held(rule.id)) },
				onRaise = before?.let { anchor ->
					{
						repo.command {
							assistantOps.runWork(workKey) { listText(moveRule(gatewayId, watcher.id, rule.id, anchor, rules.held.revision)) }
						}
					}
				},
			)
		}
		RuleRow(
			number = "·",
			text = "Anything else",
			invalid = null,
			action = rules.held.otherwise.action,
			onOpen = { onEdit(RuleSlot.Otherwise) },
			onRaise = null,
		)
		TextButton(
			onClick = hapticClick { onEdit(RuleSlot.New) },
			enabled = !busy && rules.held.rules.size < MAX_RULES,
		) { Text("+ Add rule") }
		works[workKey]?.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	}
}

@Composable
private fun RuleRow(
	number: String,
	text: String,
	invalid: String?,
	action: String,
	onOpen: () -> Unit,
	onRaise: (() -> Unit)?,
) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Text(
			number,
			Modifier.width(20.dp),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		val dim = MaterialTheme.colorScheme.onSurfaceVariant
		Column(Modifier.weight(1f)) {
			if (invalid == null) {
				Text(text, style = MaterialTheme.typography.bodyMedium)
			} else {
				Text(text, style = MaterialTheme.typography.bodyMedium, color = dim, textDecoration = TextDecoration.LineThrough)
				Text(invalid, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			}
		}
		Text(
			actionLabel(action),
			style = MaterialTheme.typography.labelLarge,
			color = if (invalid == null) MaterialTheme.colorScheme.primary else dim,
		)
		if (onRaise != null) {
			IconButton(onClick = hapticClick(onRaise)) { Icon(Icons.Default.ArrowUpward, contentDescription = "Move up") }
		} else {
			Box(Modifier.width(48.dp))
		}
	}
}

/** Drafts outlive this page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RuleEditorPage(
	repo: ChatRepository,
	gatewayId: String,
	watcher: AssistantWatcher,
	slot: RuleSlot,
	onClose: () -> Unit,
) {
	val ops = repo.assistantOps
	val rules = rulesOf(watcher) ?: return
	val key = RuleDraftKey(gatewayId, watcher.id, slot)
	val drafts by ops.ruleDrafts.collectAsState()
	val landed by ops.ruleLanded.collectAsState()
	val held = drafts[key]
	var shown by remember(key) { mutableStateOf<Long?>(null) }
	LaunchedEffect(held?.opening) { held?.opening?.let { shown = it } }
	LaunchedEffect(shown, landed[key]) { if (editorLanded(shown, landed[key])) onClose() }
	val opened = remember(key, rules.held) { RuleDraft.of(slot, rules) }
	val draft = held?.draft ?: opened
	if (draft == null) {
		// Rule deleted before opening.
		LaunchedEffect(key) { onClose() }
		return
	}
	val gone = goneFrom(rules, slot)
	val busy = held?.busy == true
	val can = ruleEditing(slot, draft, busy, gone, rules)
	val rule = fittingRule(draft, rules)
	var preview by remember(key) { mutableStateOf<String?>(null) }

	if (slot != RuleSlot.Otherwise && !gone) {
		LaunchedEffect(rule, rules.held.revision) {
			preview = null
			val asked = rule ?: return@LaunchedEffect
			delay(PREVIEW_DEBOUNCE_MS)
			preview = ops.preview(gatewayId, watcher.id, asked)?.let(::previewText) ?: "Could not check recent events."
		}
	}

	// Held before sending, so its landing closes this page.
	fun send(edit: RuleEdit, op: suspend (RuleDraft) -> RuleSaved) {
		shown = ops.holdRule(key, draft)
		repo.command { assistantOps.sendRule(key, draft, edit, op) }
	}

	val save: (suspend (RuleDraft) -> RuleSaved)? = if (slot == RuleSlot.Otherwise) {
		{ sent -> ops.saveOtherwise(gatewayId, watcher.id, sent.toOtherwise()) }
	} else {
		rule?.let {
			{ sent -> fittingRule(sent, rules)?.let { ops.saveRule(gatewayId, watcher.id, it) } ?: RuleSaved.Refused("Not a complete rule", null) }
		}
	}

	EditorScaffold(
		title = when {
			gone -> "Deleted elsewhere"
			slot is RuleSlot.Held -> "Rule ${rules.held.rules.indexOfFirst { it.id == slot.id } + 1}"
			slot == RuleSlot.New -> "New rule"
			else -> "Anything else"
		},
		saving = busy,
		canSave = can.save && save != null,
		onCancel = {
			ops.cancelRule(key)
			onClose()
		},
		onSave = { save?.let { send(RuleEdit.SAVE, it) } },
	) {
		if (slot != RuleSlot.Otherwise) {
			Text("When", style = MaterialTheme.typography.labelLarge)
			draft.conditions.forEachIndexed { index, condition ->
				if (index > 0) {
					Text("and", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
				Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
					Box(Modifier.weight(1f)) {
						PickMenu(
							label = "Field",
							choices = rules.fields,
							picked = condition.field,
							labelOf = rules::fieldLabelOf,
							onPick = { field -> ops.editRule(key, draft.withField(index, field, rules)) },
							enabled = can.edit,
						)
					}
					Box(Modifier.weight(0.7f)) {
						PickMenu(
							label = "Test",
							choices = testsOf(rules.specOf(condition.field)),
							picked = condition.test,
							labelOf = ::testLabel,
							onPick = { test -> ops.editRule(key, draft.changed(index) { it.copy(test = test) }) },
							enabled = can.edit,
						)
					}
					if (draft.conditions.size > 1) {
						IconButton(onClick = hapticClick { ops.editRule(key, draft.withoutCondition(index)) }, enabled = can.edit) {
							Icon(Icons.Default.Close, contentDescription = "Remove condition")
						}
					}
				}
				val choices = rules.choicesFor(condition.field, condition.value)
				if (choices != null) {
					PickMenu(
						label = "Value",
						choices = choices,
						picked = condition.value.takeIf { trimRuleValue(it).isNotEmpty() },
						labelOf = { value -> rules.valueLabelOf(condition.field, value) },
						onPick = { value -> ops.editRule(key, draft.changed(index) { it.copy(value = value) }) },
						trailingOf = { value -> "not offered".takeUnless { rules.offers(condition.field, value) } },
						enabled = can.edit,
					)
				} else {
					OutlinedTextField(
						value = condition.value,
						onValueChange = { value -> ops.editRule(key, draft.changed(index) { it.copy(value = value) }) },
						label = { Text("Value") },
						singleLine = true,
						enabled = can.edit,
						modifier = Modifier.fillMaxWidth(),
					)
				}
				rules.issueOf(condition)?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
				}
			}
			if (draft.conditions.size < MAX_CONDITIONS) {
				TextButton(onClick = hapticClick { ops.editRule(key, draft.withCondition(rules)) }, enabled = can.edit) {
					Text("+ Add condition")
				}
			}
		}

		Text("Then", style = MaterialTheme.typography.labelLarge)
		SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
			RULE_ACTIONS.forEachIndexed { index, action ->
				SegmentedButton(
					selected = draft.action == action,
					onClick = hapticClick { ops.editRule(key, draft.copy(action = action)) },
					enabled = can.edit,
					shape = SegmentedButtonDefaults.itemShape(index = index, count = RULE_ACTIONS.size),
				) { Text(actionLabel(action)) }
			}
		}
		preview?.let {
			Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		held?.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

		if (slot is RuleSlot.Held) {
			HorizontalDivider()
			TextButton(
				onClick = hapticClick {
					send(RuleEdit.DELETE) { sent -> ops.deleteRule(gatewayId, watcher.id, sent.id, sent.revision) }
				},
				enabled = can.delete,
			) { Text("Delete") }
		}
	}
}
