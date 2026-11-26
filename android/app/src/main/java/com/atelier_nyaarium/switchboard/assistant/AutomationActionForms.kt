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
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.ActionParamKind

@Composable
internal fun ActionsSection(
	draft: AutomationDraft,
	offer: AutomationOffer,
	enabled: Boolean,
	said: AutomationSaid?,
	/** Null asks nothing. */
	textRead: @Composable (String?) -> PreviewRead,
	asked: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val functionParams = (draft.runs as? RunsHead.Points)?.pointing?.params.orEmpty()
	val valueNames = functionParams.filter { it.param.name.isNotBlank() }.map { it.key }.toSet()
	val plugs = plugChoices(functionParams, offer)
	draft.actions.forEachIndexed { index, action ->
		OutlinedCard(Modifier.fillMaxWidth()) {
			Column(Modifier.padding(start = 12.dp, end = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(offer.labelOf(action.kind), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
					IconButton(onClick = hapticClick { edit { it.minusAction(index) } }, enabled = enabled && canRemove(draft, index, offer)) {
						Icon(Icons.Default.Close, contentDescription = "Remove action")
					}
				}
				Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
					val set: (String, String) -> Unit = { param, value -> edit { it.withAction(index) { held -> withValue(held, param, value) } } }
					when (action) {
						is ActionDraft.Filled -> for (field in actionFields(action, offer)) {
							val param = field.param
							val value = field.value
							if (param == null) {
								StrayValue(field, enabled) { edit { it.withAction(index) { held -> withoutValue(held, field.name) } } }
								continue
							}
							when (param.paramKind) {
								ActionParamKind.CHOICE -> ChoiceRow(
									choices = param.options,
									picked = param.options.find { it.value == value },
									labelOf = { it.label },
									enabledOf = { enabled },
									onPick = { picked -> set(param.name, picked.value) },
								)
								ActionParamKind.SWITCH -> PickMenu(
									label = param.label,
									choices = plugs,
									picked = action.references[param.name]?.let { reference ->
										plugs.firstOrNull { it.reference?.key == reference.key } ?: PlugChoice(reference.key, "${reference.name} (value)", reference)
									} ?: plugs.firstOrNull { it.reference == null && it.device == value },
									labelOf = { it.label },
									onPick = { picked -> edit { it.withAction(index) { held -> storePlugChoice(held, param.name, picked) } } },
									enabled = enabled,
								)
								ActionParamKind.TEXT -> HoleField(
									label = param.label,
									value = value,
									multiline = param.lines,
									enabled = enabled,
									preview = textPreviewOf(value, asked, textRead(previewText(value).takeIf { asked })),
									refused = refusedHole(said, index, param.name, value),
									onOpen = { edit { it.copy(text = TextRef(index, param.name)) } },
								)
								ActionParamKind.WORD -> OutlinedTextField(
									value = value,
									onValueChange = { typed -> set(param.name, typed) },
									label = { Text(param.label) },
									singleLine = true,
									keyboardOptions = EXACT_KEYBOARD,
									enabled = enabled,
									modifier = Modifier.fillMaxWidth(),
								)
								ActionParamKind.FUNCTION, ActionParamKind.VALUES, null -> Unit
							}
							IssueLine(refusedField(said, SaidAt.Card(index, param.name), value))
						}
						is ActionDraft.Kept -> Text(
							"This app cannot edit this action. It is kept as it is.",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					if (offer.dangerous(action.kind)) {
						Text(
							"Asks once when saved.",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					IssueLine(actionHint(action, offer, valueNames))
					IssueLine(actionWarning(action, offer))
				}
			}
		}
	}
	AddAction(addableActions(offer, draft.actions), enabled) { kind ->
		edit { held -> freshAction(kind, offer)?.let(held::plusAction) ?: held }
	}
}

/** A value its row no longer names. */
@Composable
private fun StrayValue(field: ParamView, enabled: Boolean, onClear: () -> Unit) {
	Row(verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text("${field.name}: ${field.value}", style = MaterialTheme.typography.bodyMedium)
			Text("No longer offered", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
		TextButton(onClick = hapticClick(onClear), enabled = enabled) { Text("Clear") }
	}
}

@Composable
private fun AddAction(offered: List<ActionOffer>, enabled: Boolean, onAdd: (String) -> Unit) {
	if (offered.isEmpty()) return
	var open by remember { mutableStateOf(false) }
	Box {
		TextButton(onClick = hapticClick { open = true }, enabled = enabled) { Text("+ Add action") }
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			for (action in offered) {
				DropdownMenuItem(
					text = { Text(action.label) },
					onClick = hapticClick {
						open = false
						onAdd(action.kind)
					},
				)
			}
		}
	}
}

/** Edited on its own page. */
@Composable
private fun HoleField(
	label: String,
	value: String,
	multiline: Boolean,
	enabled: Boolean,
	preview: TextPreview,
	refused: AutomationSaid.Hole?,
	onOpen: () -> Unit,
) {
	Box {
		OutlinedTextField(
			value = value,
			onValueChange = {},
			readOnly = true,
			label = { Text(label) },
			singleLine = !multiline,
			minLines = if (multiline) 2 else 1,
			maxLines = if (multiline) 6 else 1,
			enabled = enabled,
			isError = refused != null || preview is TextPreview.Refused,
			modifier = Modifier.fillMaxWidth(),
		)
		Box(Modifier.matchParentSize().clickable(enabled = enabled, onClick = hapticClick(onOpen)))
	}
	TextPreviewBlock(value, preview, refused)
}

/** Gateway reading, or refused hole. */
@Composable
internal fun TextPreviewBlock(value: String, preview: TextPreview, refused: AutomationSaid.Hole?) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	when (preview) {
		TextPreview.Plain -> Unit
		TextPreview.Asking -> Text("Checking", style = MaterialTheme.typography.bodySmall, color = dim)
		TextPreview.Unread -> Text("Could not preview this text.", style = MaterialTheme.typography.bodySmall, color = dim)
		is TextPreview.Filled -> Card(Modifier.fillMaxWidth()) {
			Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
				Text("Preview", style = MaterialTheme.typography.labelSmall, color = dim)
				Text(preview.text, style = MaterialTheme.typography.bodyMedium)
			}
		}
		is TextPreview.Refused -> IssueLine(holeLine(value, preview.line, preview.start, preview.end))
	}
	if (preview !is TextPreview.Refused) IssueLine(refused?.let { holeLine(value, it.line, it.start, it.end) })
}
