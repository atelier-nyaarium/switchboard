package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.Protocol

/** Past the card's padding. */
private val INDENT = 8.dp

@Composable
internal fun CardsSection(
	draft: AutomationDraft,
	offer: AutomationOffer,
	/** The page's current fields. */
	fields: SourceFields,
	enabled: Boolean,
	said: AutomationSaid?,
	/** Null asks nothing. */
	textRead: @Composable (String?) -> PreviewRead,
	conditionRead: @Composable (String) -> PreviewRead,
	asked: Boolean,
	lastRun: AutomationLastRun?,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	/** Re-reads a changed function. */
	reload: (String) -> Unit,
	/** Null selects automation cards. */
	tree: String? = null,
	/** Script lines of script-only cards. */
	scriptLines: Map<String, ScriptOnlyLine> = emptyMap(),
	/** Opens script at offset. */
	onScriptAt: ((Int) -> Unit)? = null,
	issues: DrawnIssues? = null,
) {
	val functionParams = if (tree == null) (draft.runs as? RunsHead.Points)?.pointing?.params.orEmpty() else draft.callees[tree]?.params.orEmpty()
	val paramKeys = functionParams.filter { it.param.name.isNotBlank() }.map { it.key }.toSet()
	val devices = deviceChoices(functionParams, offer)
	val calleeParams = calleeParamsOf(draft, offer)
	val rows = cardsDraw(
		draft.stepsOf(tree),
		{ step -> cardIssueOf(step, issues) { cardHint(it, offer, paramKeys, calleeParams) } },
		lastRun,
		pointing = draft.runs is RunsHead.Points,
		choicesOf = { subject -> switchOptions(subject, fields) },
	)
	val running = lastRun?.running == true
	lastRun?.let { run ->
		Text(
			if (run.running) "Running now" else "Last run ${agoText(run.at)}",
			style = MaterialTheme.typography.labelMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
	val inputs = CardInputs(
		draft, offer, fields, devices, paramKeys, enabled, said, textRead, conditionRead, asked, running, edit, reload, tree, scriptLines, onScriptAt,
		counts = issues?.functions.orEmpty(),
	)
	CardBlocks(cardBlocks(rows), inputs)
}

private class CardInputs(
	val draft: AutomationDraft,
	val offer: AutomationOffer,
	val fields: SourceFields,
	val devices: List<DeviceChoice>,
	val paramKeys: Set<String>,
	val enabled: Boolean,
	val said: AutomationSaid?,
	val textRead: @Composable (String?) -> PreviewRead,
	val conditionRead: @Composable (String) -> PreviewRead,
	val asked: Boolean,
	val running: Boolean,
	val edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	val reload: (String) -> Unit,
	val tree: String?,
	val scriptLines: Map<String, ScriptOnlyLine>,
	val onScriptAt: ((Int) -> Unit)?,
	val counts: Map<String, IssueCount>,
)

@Composable
private fun CardBlocks(blocks: List<CardBlock>, inputs: CardInputs) {
	for (block in blocks) {
		key(block.row.rowKey) {
			Box(Modifier.padding(start = if (block.indented) INDENT else 0.dp)) {
				when (block) {
					is CardBlock.Owner -> StepCard(block.row, inputs) { CardBlocks(block.inside, inputs) }
					is CardBlock.Loose -> LooseRow(block.row, inputs)
				}
			}
		}
	}
}

@Composable
private fun LooseRow(row: CardRow, inputs: CardInputs) {
	val enabled = inputs.enabled
	val edit = inputs.edit
	when (row) {
		// Owners hold cards.
		is CardRow.Card -> Unit
		is CardRow.SideLabel -> Text(
			sideLabel(row.side),
			style = MaterialTheme.typography.labelLarge,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		is CardRow.AddSlot -> AddStep(addSlotText(row), slotOffers(inputs.draft, inputs.offer, row), enabled, { freshAction(it, inputs.offer) }) { added ->
			edit { held -> held.plusStep(row.slot, added, inputs.tree) }
		}
		is CardRow.Branch -> BranchRow(row, enabled, inputs.said, inputs.conditionRead, inputs.asked, edit)
		is CardRow.AddBranch -> TextButton(onClick = hapticClick { edit { addedBranch(it, row) } }, enabled = enabled && !row.full) {
			Text(addBranchText(row.kind))
		}
	}
}

private fun sideLabel(side: Side): String = when (side) {
	Side.Else -> "Else"
	Side.Catch -> "Catch"
	Side.Then, Side.Body, is Side.Case, is Side.Default -> ""
}

@Composable
private fun StepCard(row: CardRow.Card, inputs: CardInputs, inside: @Composable () -> Unit) {
	val draft = inputs.draft
	val offer = inputs.offer
	val enabled = inputs.enabled
	val said = inputs.said
	val conditionRead = inputs.conditionRead
	val asked = inputs.asked
	val edit = inputs.edit
	val step = row.step
	val key = step.key
	val scriptLine = inputs.scriptLines[key]
	val onScriptAt = inputs.onScriptAt
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	OutlinedCard(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(start = 12.dp, end = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Text(cardLabel(step, offer), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
				val siblings = draft.stepsOf(draft.treeHolding(key))
				MoveMenu(mayMove(siblings, key), enabled, { moveChoices(siblings, key, offer) { switchOptions(it, inputs.fields) } }) { slot ->
					edit { it.movedTo(key, slot) }
				}
				IconButton(onClick = hapticClick { edit { it.minusStep(key) } }, enabled = enabled && canRemove(draft, key, offer)) {
					Icon(Icons.Default.Close, contentDescription = "Remove step")
				}
			}
			Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
				when (step) {
					is StepDraft.Action -> ActionFields(key, step.action, offer, inputs.devices, inputs.paramKeys, enabled, said, inputs.textRead, asked, edit)
					is StepDraft.If -> if (!drawnAsChain(step)) ConditionBlock(step, enabled, said, conditionRead, asked, edit)
					is StepDraft.Switch -> ExpressionBlock(key, SUBJECT, step.subject, "Subject", enabled, said, edit)
					is StepDraft.Wait -> {
						OutlinedTextField(
							value = step.minutes,
							onValueChange = { typed -> edit { it.withStep(key) { held -> (held as? StepDraft.Wait)?.copy(minutes = typed) ?: held } } },
							label = { Text("For") },
							suffix = { Text("min") },
							singleLine = true,
							enabled = enabled,
							keyboardOptions = NUMBER_KEYS,
							modifier = Modifier.fillMaxWidth(),
						)
						IssueLine(refusedField(said, SaidAt.Card(key, MINUTES), step.minutes))
					}
					is StepDraft.Comment -> OutlinedTextField(
						value = step.text,
						onValueChange = { typed ->
							edit { it.withStep(key) { held -> (held as? StepDraft.Comment)?.copy(text = typed.take(Protocol.Wire.STEP_TEXT_MAX)) ?: held } }
						},
						minLines = 2,
						maxLines = 6,
						enabled = enabled,
						modifier = Modifier.fillMaxWidth(),
					)
					is StepDraft.Return -> Text("Ends this function here.", style = MaterialTheme.typography.bodySmall, color = dim)
					is StepDraft.Try, is StepDraft.Parallel -> Unit
					is StepDraft.RunFunction ->
						RunFunctionFields(step, draft, offer, inputs.fields, inputs.tree, enabled, said, edit, inputs.reload, inputs.counts)
					is StepDraft.Variable -> {
						NameField(step.name, "Name", enabled) { typed -> edit { it.withStep(key) { held -> (held as? StepDraft.Variable)?.copy(name = typed) ?: held } } }
						IssueLine(refusedField(said, SaidAt.Card(key, NAME), step.name))
						ExpressionBlock(key, VALUE, step.value, "Value", enabled, said, edit)
					}
					is StepDraft.Start -> {
						NameField(step.name, "Name", enabled) { typed -> edit { it.withStep(key) { held -> (held as? StepDraft.Start)?.copy(name = typed) ?: held } } }
						IssueLine(refusedField(said, SaidAt.Card(key, AS), step.name))
					}
					is StepDraft.Await -> {
						ExpressionBlock(key, TASK, step.task, "Task", enabled, said, edit)
						NameField(step.name, "Result name", enabled) { typed -> edit { it.withStep(key) { held -> (held as? StepDraft.Await)?.copy(name = typed) ?: held } } }
						IssueLine(refusedField(said, SaidAt.Card(key, AS), step.name))
					}
					is StepDraft.Throw -> {
						OutlinedTextField(
							value = step.text.orEmpty(),
							onValueChange = { typed ->
								edit { it.withStep(key) { held -> (held as? StepDraft.Throw)?.copy(text = typed.take(Protocol.Wire.STEP_TEXT_MAX)) ?: held } }
							},
							label = { Text("Message") },
							singleLine = true,
							enabled = enabled,
							modifier = Modifier.fillMaxWidth(),
						)
						IssueLine(refusedField(said, SaidAt.Card(key, TEXT), step.text.orEmpty()))
					}
					is StepDraft.ScriptOnly -> if (scriptLine != null) {
						Text(scriptLine.text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
						onScriptAt?.let { open -> TextButton(onClick = hapticClick { open(scriptLine.at) }, enabled = enabled) { Text("Edit in script") } }
					}
				}
				CardIssueLine(row.issue)
				lastStepLine(row, inputs.running)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = dim) }
				inside()
			}
		}
	}
}

@Composable
private fun NameField(value: String, label: String, enabled: Boolean, onChange: (String) -> Unit) {
	OutlinedTextField(
		value = value,
		onValueChange = { typed -> onChange(typed.take(Protocol.Wire.FUNCTION_PARAM_NAME_MAX)) },
		label = { Text(label) },
		singleLine = true,
		enabled = enabled,
		keyboardOptions = EXACT_KEYBOARD,
		modifier = Modifier.fillMaxWidth(),
	)
}

/** Choices read on open. */
@Composable
private fun MoveMenu(movable: Boolean, enabled: Boolean, choicesOf: () -> List<MoveChoice>, onMove: (Slot) -> Unit) {
	if (!movable) return
	var shown by remember { mutableStateOf(emptyList<MoveChoice>()) }
	Box {
		IconButton(onClick = hapticClick { shown = choicesOf() }, enabled = enabled) {
			Icon(Icons.Default.MoreVert, contentDescription = "Move step")
		}
		DropdownMenu(expanded = shown.isNotEmpty(), onDismissRequest = { shown = emptyList() }) {
			for (choice in shown) {
				DropdownMenuItem(text = { Text(choice.label) }, onClick = hapticClick { shown = emptyList(); onMove(choice.slot) })
			}
		}
	}
}

@Composable
private fun ConditionBlock(
	step: StepDraft.If,
	enabled: Boolean,
	said: AutomationSaid?,
	conditionRead: @Composable (String) -> PreviewRead,
	asked: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val refused = refusedPlaceholder(said, step.key, CONDITION, step.condition)
	val shown = conditionSaidOf(step.condition, asked, conditionRead(step.condition))
	ConditionField(step.condition, "Condition", enabled, refused != null || shown is ConditionSaid.Issue) {
		edit { it.copy(text = TextRef(step.key, CONDITION)) }
	}
	ConditionSaidBlock(step.condition, shown, refused)
}

/** An expression opened on its own page. */
@Composable
private fun ExpressionBlock(
	key: String,
	param: String,
	value: String,
	label: String,
	enabled: Boolean,
	said: AutomationSaid?,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val refused = refusedPlaceholder(said, key, param, value)
	ConditionField(value, label, enabled, refused != null) { edit { it.copy(text = TextRef(key, param)) } }
	IssueLine(refused?.let { placeholderLine(value, it.line, it.start, it.end) } ?: refusedField(said, SaidAt.Card(key, param), value))
}

@Composable
private fun BranchRow(
	row: CardRow.Branch,
	enabled: Boolean,
	said: AutomationSaid?,
	conditionRead: @Composable (String) -> PreviewRead,
	asked: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
		when (val label = row.label) {
			is BranchLabel.Case -> {
				BranchTitle("Case", label.taken) {
					IconButton(onClick = hapticClick { edit { it.withSwitch(row.parent) { held -> withoutCase(held, label.view.case.key) } } }, enabled = enabled) {
						Icon(Icons.Default.Close, contentDescription = "Remove case")
					}
				}
				CaseChips(label.view, enabled) { change -> edit { it.withSwitch(row.parent) { held -> change(held) } } }
			}
			is BranchLabel.Default -> {
				BranchTitle("Default", label.taken)
				Text(label.falls, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
			}
			is BranchLabel.Link -> {
				if (!label.first) {
					BranchTitle("Else if", taken = false) {
						IconButton(onClick = hapticClick { edit { it.minusLink(label.step.key) } }, enabled = enabled) {
							Icon(Icons.Default.Close, contentDescription = "Remove else if")
						}
					}
				}
				ConditionBlock(label.step, enabled, said, conditionRead, asked, edit)
				CardIssueLine(label.issue)
				lastLineOf(label.step, label.last)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = dim) }
			}
			BranchLabel.Else -> BranchTitle("Else", taken = false)
			is BranchLabel.Parallel -> BranchTitle("Branch ${label.number}", taken = false)
		}
	}
}

@Composable
private fun BranchTitle(text: String, taken: Boolean, end: @Composable () -> Unit = {}) {
	Row(verticalAlignment = Alignment.CenterVertically) {
		Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
		if (taken) Text("Last run", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
		Box(Modifier.weight(1f))
		end()
	}
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CaseChips(view: CaseView, enabled: Boolean, change: ((StepDraft.Switch) -> StepDraft.Switch?) -> Unit) {
	val case = view.case.key
	var typing by remember(case) { mutableStateOf(false) }
	var picking by remember(case) { mutableStateOf(false) }
	FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.Center) {
		view.chips.forEachIndexed { at, chip ->
			val tone = chip.issue?.let { if (drawsAsError(it.level)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outline }
			ValueChip(chip.label, enabled, tone) { change { held -> withoutCaseValue(held, case, at) } }
		}
		when (val add = view.add) {
			CaseAdd.Full -> Unit
			CaseAdd.Type -> AddChip(enabled) { typing = true }
			is CaseAdd.Pick -> Box {
				AddChip(enabled) { picking = true }
				DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
					for (option in add.options) {
						DropdownMenuItem(
							text = { Text(option.label) },
							onClick = hapticClick {
								picking = false
								change { held -> withCaseValue(held, case, option.value) }
							},
						)
					}
				}
			}
		}
	}
	if (typing && view.add == CaseAdd.Type) CaseValueEntry(enabled, onDone = { typing = false }) { value -> change { held -> withCaseValue(held, case, value) } }
	for (chip in view.chips) CardIssueLine(chip.issue)
	CardIssueLine(view.issue)
}

@Composable
private fun CaseValueEntry(enabled: Boolean, onDone: () -> Unit, onAdd: (String) -> Unit) {
	var typed by remember { mutableStateOf("") }
	val value = caseValueOf(typed)
	val add = {
		value?.let(onAdd)
		typed = ""
		onDone()
	}
	Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
		OutlinedTextField(
			value = typed,
			onValueChange = { typed = it },
			label = { Text("Value") },
			singleLine = true,
			keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
			keyboardActions = KeyboardActions(onDone = { add() }),
			enabled = enabled,
			modifier = Modifier.weight(1f),
		)
		TextButton(onClick = hapticClick(add), enabled = enabled && value != null) { Text("Add") }
	}
}

@Composable
private fun ConditionField(value: String, label: String, enabled: Boolean, refused: Boolean, onOpen: () -> Unit) {
	Box {
		OutlinedTextField(
			value = value,
			onValueChange = {},
			readOnly = true,
			label = { Text(label) },
			singleLine = true,
			enabled = enabled,
			isError = refused,
			textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
			modifier = Modifier.fillMaxWidth(),
		)
		Box(Modifier.matchParentSize().clickable(enabled = enabled, onClick = hapticClick(onOpen)))
	}
}

/** Its issue, else the warning the preview answers. */
@Composable
internal fun ConditionSaidBlock(value: String, said: ConditionSaid, refused: AutomationSaid.Placeholder?) {
	when (said) {
		ConditionSaid.Silent -> IssueLine(refused?.let { placeholderLine(value, it.line, it.start, it.end) })
		is ConditionSaid.Issue -> IssueLine(placeholderLine(value, said.line, said.start, said.end))
		is ConditionSaid.Warning -> {
			Text(issueText(said.line), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
			IssueLine(refused?.let { placeholderLine(value, it.line, it.start, it.end) })
		}
	}
}

@Composable
private fun AddStep(label: String, offers: SlotOffers, enabled: Boolean, freshOf: (String) -> ActionDraft?, onAdd: (StepDraft) -> Unit) {
	if (offers.empty) return
	var open by remember { mutableStateOf(false) }
	Box {
		TextButton(onClick = hapticClick { open = true }, enabled = enabled) { Text(label) }
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			for (action in offers.actions) {
				DropdownMenuItem(
					text = { Text(action.label) },
					onClick = hapticClick {
						open = false
						freshOf(action.kind)?.let { onAdd(StepDraft.Action(freshKey(), it)) }
					},
				)
			}
			if (offers.actions.isNotEmpty() && offers.statements.isNotEmpty()) HorizontalDivider()
			for (statement in offers.statements) {
				DropdownMenuItem(
					text = { Text(statement.label) },
					onClick = hapticClick {
						open = false
						freshStatement(statement.kind)?.let(onAdd)
					},
				)
			}
		}
	}
}
