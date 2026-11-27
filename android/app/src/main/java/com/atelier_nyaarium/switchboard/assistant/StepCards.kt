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
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.Protocol

private val INDENT = 16.dp

@Composable
internal fun CardsSection(
	draft: AutomationDraft,
	offer: AutomationOffer,
	enabled: Boolean,
	said: AutomationSaid?,
	/** Null asks nothing. */
	textRead: @Composable (String?) -> PreviewRead,
	conditionRead: @Composable (String) -> PreviewRead,
	asked: Boolean,
	lastRun: AutomationLastRun?,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	/** Re-reads a moved callee. */
	reload: (String) -> Unit,
	/** Null selects automation cards. */
	tree: String? = null,
	/** Kept script lines. */
	kept: Map<String, KeptLine> = emptyMap(),
	/** Opens script at offset. */
	onScriptAt: ((Int) -> Unit)? = null,
) {
	val functionParams = if (tree == null) (draft.runs as? RunsHead.Points)?.pointing?.params.orEmpty() else draft.callees[tree]?.params.orEmpty()
	val valueNames = functionParams.filter { it.param.name.isNotBlank() }.map { it.key }.toSet()
	val plugs = plugChoices(functionParams, offer)
	val rows = cardsDraw(draft.stepsOf(tree), { cardHint(it, offer, valueNames, calleeParamsOf(draft, offer)) }, lastRun, pointing = draft.runs is RunsHead.Points)
	val running = lastRun?.running == true
	lastRun?.let { run ->
		Text(
			if (run.running) "Running now" else "Last run ${agoText(run.at)}",
			style = MaterialTheme.typography.labelMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
	for (row in rows) {
		key(row.rowKey) {
			Box(Modifier.padding(start = INDENT * row.depth)) {
				when (row) {
					is CardRow.Card -> StepCard(row, draft, offer, plugs, valueNames, enabled, said, textRead, conditionRead, asked, running, edit, reload, tree, kept[row.step.key], onScriptAt)
					is CardRow.SideLabel -> Text(
						sideLabel(row.side),
						style = MaterialTheme.typography.labelLarge,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					is CardRow.AddSlot -> AddStep(slotOffers(draft, offer, row), enabled, nested = row.depth > 0, { freshAction(it, offer) }) { added ->
						edit { held -> held.plusStep(row.slot, added, tree) }
					}
				}
			}
		}
	}
}

private fun sideLabel(side: Side): String = when (side) {
	Side.ELSE -> "Otherwise"
	Side.CATCH -> "If it fails"
	Side.THEN, Side.BODY -> ""
}

@Composable
private fun StepCard(
	row: CardRow.Card,
	draft: AutomationDraft,
	offer: AutomationOffer,
	plugs: List<PlugChoice>,
	valueNames: Set<String>,
	enabled: Boolean,
	said: AutomationSaid?,
	textRead: @Composable (String?) -> PreviewRead,
	conditionRead: @Composable (String) -> PreviewRead,
	asked: Boolean,
	running: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	reload: (String) -> Unit,
	tree: String?,
	kept: KeptLine?,
	onScriptAt: ((Int) -> Unit)?,
) {
	val step = row.step
	val key = step.key
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	OutlinedCard(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(start = 12.dp, end = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Text(cardLabel(step, offer), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
				MoveMenu(draft.stepsOf(draft.treeHolding(key)), key, enabled) { slot -> edit { it.movedTo(key, slot) } }
				IconButton(onClick = hapticClick { edit { it.minusStep(key) } }, enabled = enabled && canRemove(draft, key, offer)) {
					Icon(Icons.Default.Close, contentDescription = "Remove step")
				}
			}
			Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
				when (step) {
					is StepDraft.Do -> ActionFields(key, step.action, offer, plugs, valueNames, enabled, said, textRead, asked, edit)
					is StepDraft.If -> {
						val refused = refusedHole(said, key, WHEN, step.condition)
						val preview = conditionPreviewOf(step.condition, asked, conditionRead(step.condition))
						ConditionField(step.condition, enabled, refused != null || preview is ConditionPreview.Refused) {
							edit { it.copy(text = TextRef(key, WHEN)) }
						}
						ConditionPreviewBlock(step.condition, preview, refused)
					}
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
					is StepDraft.Note -> OutlinedTextField(
						value = step.text,
						onValueChange = { typed ->
							edit { it.withStep(key) { held -> (held as? StepDraft.Note)?.copy(text = typed.take(Protocol.Wire.STEP_TEXT_MAX)) ?: held } }
						},
						minLines = 2,
						maxLines = 6,
						enabled = enabled,
						modifier = Modifier.fillMaxWidth(),
					)
					is StepDraft.Exit -> Text("Ends the run here.", style = MaterialTheme.typography.bodySmall, color = dim)
					is StepDraft.Try -> Unit
					is StepDraft.Call -> CallFields(step, draft, offer, tree, enabled, said, edit, reload)
					is StepDraft.Kept -> if (kept != null) {
						Text(kept.text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
						onScriptAt?.let { open -> TextButton(onClick = hapticClick { open(kept.at) }, enabled = enabled) { Text("Edit in script") } }
					} else {
						Text("This app cannot edit this step yet. It is kept as it is.", style = MaterialTheme.typography.bodySmall, color = dim)
					}
				}
				IssueLine(row.issue)
				lastStepLine(row, running)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = dim) }
			}
		}
	}
}

/** Moves within sibling list. */
@Composable
private fun MoveMenu(steps: List<StepDraft>, key: String, enabled: Boolean, onMove: (Slot) -> Unit) {
	val up = shiftedSlot(steps, key, -1)
	val down = shiftedSlot(steps, key, 1)
	if (up == null && down == null) return
	var open by remember { mutableStateOf(false) }
	Box {
		IconButton(onClick = hapticClick { open = true }, enabled = enabled) {
			Icon(Icons.Default.MoreVert, contentDescription = "Move step")
		}
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			up?.let { slot -> DropdownMenuItem(text = { Text("Move up") }, onClick = hapticClick { open = false; onMove(slot) }) }
			down?.let { slot -> DropdownMenuItem(text = { Text("Move down") }, onClick = hapticClick { open = false; onMove(slot) }) }
		}
	}
}

/** Opens the condition editor. */
@Composable
private fun ConditionField(value: String, enabled: Boolean, refused: Boolean, onOpen: () -> Unit) {
	Box {
		OutlinedTextField(
			value = value,
			onValueChange = {},
			readOnly = true,
			label = { Text("Condition") },
			singleLine = true,
			enabled = enabled,
			isError = refused,
			textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
			modifier = Modifier.fillMaxWidth(),
		)
		Box(Modifier.matchParentSize().clickable(enabled = enabled, onClick = hapticClick(onOpen)))
	}
}

@Composable
internal fun ConditionPreviewBlock(value: String, preview: ConditionPreview, refused: AutomationSaid.Hole?) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	when (preview) {
		ConditionPreview.Plain -> Unit
		ConditionPreview.Asking -> Text("Checking", style = MaterialTheme.typography.bodySmall, color = dim)
		ConditionPreview.Unread -> Text("Could not read it now.", style = MaterialTheme.typography.bodySmall, color = dim)
		is ConditionPreview.Holds -> Text(
			if (preview.holds) "True right now" else "False right now",
			style = MaterialTheme.typography.bodySmall,
			color = if (preview.holds) MaterialTheme.colorScheme.primary else dim,
		)
		is ConditionPreview.CannotTell -> Text("Can't tell now: ${preview.why}", style = MaterialTheme.typography.bodySmall, color = dim)
		is ConditionPreview.Refused -> IssueLine(holeLine(value, preview.line, preview.start, preview.end))
	}
	if (preview !is ConditionPreview.Refused) IssueLine(refused?.let { holeLine(value, it.line, it.start, it.end) })
}

@Composable
private fun AddStep(
	offers: SlotOffers,
	enabled: Boolean,
	nested: Boolean,
	freshOf: (String) -> ActionDraft?,
	onAdd: (StepDraft) -> Unit,
) {
	if (offers.empty) return
	var open by remember { mutableStateOf(false) }
	Box {
		TextButton(onClick = hapticClick { open = true }, enabled = enabled) { Text(if (nested) "+ Add" else "+ Add step") }
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			for (action in offers.actions) {
				DropdownMenuItem(
					text = { Text(action.label) },
					onClick = hapticClick {
						open = false
						freshOf(action.kind)?.let { onAdd(StepDraft.Do(freshKey(), it)) }
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
