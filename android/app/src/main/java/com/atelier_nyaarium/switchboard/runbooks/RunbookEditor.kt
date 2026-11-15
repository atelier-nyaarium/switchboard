package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.EditKey
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.MirroredDraft
import com.atelier_nyaarium.switchboard.RemoveMenu
import com.atelier_nyaarium.switchboard.editStanding
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.refusalToShow
import com.atelier_nyaarium.switchboard.rememberEdit

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunbookEditor(repo: ChatRepository, gatewayId: String, runbookId: String?, onClose: () -> Unit) {
	val existing = remember(gatewayId, runbookId) { runbookId?.let { repo.runbooks.find(gatewayId, it) } }
	// The repository outlives this activity, so an edit in progress survives a rotation there.
	val edits = repo.runbookOps.edits
	val key = EditKey(gatewayId, runbookId)
	// The library is on this phone, so it is always read.
	val open = rememberEdit(edits, key, editStanding(runbookId, existing, listed = true), "Edit runbook", onClose) {
		existing?.let { RunbookDraft.of(it) } ?: RunbookDraft(id = newRunbookId())
	} ?: return
	val opening = open.opening
	val session = open.session
	val close = open.close
	val typed = remember(key, opening) { MirroredDraft(session.draft) { next -> edits.edit(key, opening) { next } } }
	var draft by typed
	// Typed while its op was out.
	LaunchedEffect(session.busy) { if (!session.busy) edits.edit(key, opening) { draft } }
	val declared = draft.declared
	val saving = session.busy
	val refused = session.said
	// Kept with the draft, or a rotation would leave the intent behind and save an ordinary edit.
	var overwriting by rememberSaveable(gatewayId, runbookId) { mutableStateOf(false) }
	var deleting by remember(gatewayId, runbookId) { mutableStateOf(false) }

	EditorScaffold(
		title = if (existing == null) "New runbook" else "Edit runbook",
		saving = saving,
		canSave = draft.refusal() == null,
		menu = { if (existing != null) RemoveMenu("Delete runbook", enabled = !saving) { deleting = true } },
		onCancel = close,
		// Sends what is typed now, on a scope that outlives this page.
		onSave = {
			val overwrite = overwriting
			overwriting = false
			edits.edit(key, opening) { draft }
			repo.command { runbookOps.commit(key, opening, overwrite) }
		},
		leaving = open.leaving,
	) {
			OutlinedTextField(
				value = draft.name,
				onValueChange = { draft = draft.copy(name = it) },
				label = { Text("Name") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			OutlinedTextField(
				value = draft.body,
				onValueChange = { draft = draft.copy(body = it) },
				label = { Text("Body") },
				supportingText = { Text("Create variables with {{name}}") },
				modifier = Modifier.fillMaxWidth().heightIn(min = 220.dp),
			)

			for (name in declared.orEmpty()) {
				ParameterCard(
					name = name,
					setting = draft.settingsFor(name),
					onEdit = { edit -> draft = draft.withSettings(name, edit) },
				)
			}

			val shown = if (overwriting || saving) {
				null
			} else {
				refusalToShow(refused, repo.runbookOps.refusalFor(gatewayId, draft.id), draft.revision)
			}
			shown?.let { refusal ->
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
						Text(refusal.reason, style = MaterialTheme.typography.bodyMedium)
						TextButton(onClick = hapticClick { overwriting = true }) { Text("Overwrite") }
					}
				}
			}
		Spacer(Modifier.height(24.dp))
	}

	if (deleting) {
		// Named rather than counted: a routine pinning this stops, and only the owner can decide
		// whether that is what they meant.
		// This Gateway's routines only. Another Gateway's copy of the id is another runbook.
		val pinning = repo.state.value.gateways.routinesOn(gatewayId)
			.filter { it.routine.runbookId == draft.id }
			.map { it.routine.name }
		ConfirmDialog(
			title = "Delete this runbook?",
			body = if (pinning.isEmpty()) {
				"It goes from this Gateway and from this phone."
			} else {
				"It goes, and these routines stop running until you give them another: " + pinning.joinToString(", ")
			},
			confirmText = "Delete",
			onConfirm = {
				deleting = false
				repo.command { runbookOps.remove(key, opening) }
			},
			onDismiss = { deleting = false },
		)
	}
}

@Composable
private fun ParameterCard(name: String, setting: ParameterDraft, onEdit: ((ParameterDraft) -> ParameterDraft) -> Unit) {
	var option by remember(name) { mutableStateOf("") }
	var editing by remember(name) { mutableStateOf<String?>(null) }

	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
			Text("{{$name}}", style = MaterialTheme.typography.titleMedium)
			OutlinedTextField(
				value = setting.label,
				onValueChange = { label -> onEdit { it.copy(label = label) } },
				label = { Text("Label") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
				SegmentedButton(
					selected = setting.kind == "text",
					onClick = hapticClick { onEdit { it.asKind("text") } },
					shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
				) { Text("Text") }
				SegmentedButton(
					selected = setting.kind == "choice",
					onClick = hapticClick { onEdit { it.asKind("choice") } },
					shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
				) { Text("Choice") }
			}

			if (setting.kind == "choice") {
				FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
					for (held in setting.options) {
						val shown = chipLabel(held)
						val isDefault = setting.default == held
						InputChip(
							selected = isDefault,
							// Tap edits; the check sets the default. One chip, two answers.
							onClick = hapticClick {
								editing = held
								option = held
							},
							label = { Text(shown, maxLines = 1, overflow = TextOverflow.Ellipsis) },
							leadingIcon = {
								IconButton(onClick = hapticClick {
									onEdit { it.copy(default = if (it.default == held) "" else held) }
								}) {
									Icon(
										Icons.Default.Check,
										contentDescription = if (isDefault) "Default" else "Make default",
										tint = if (isDefault) {
											MaterialTheme.colorScheme.primary
										} else {
											MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f)
										},
									)
								}
							},
							trailingIcon = {
								IconButton(onClick = hapticClick {
									onEdit { it.copy(options = it.options - held, default = if (it.default == held) "" else it.default) }
									if (editing == held) {
										editing = null
										option = ""
									}
								}) { Icon(Icons.Default.Close, contentDescription = "Remove $shown") }
							},
						)
					}
				}
				val ready = trimmedOption(option)
				Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
					OutlinedTextField(
						value = option,
						onValueChange = { option = it },
						label = { Text("Option") },
						modifier = Modifier.weight(1f).heightIn(max = 200.dp),
					)
					val held = editing
					TextButton(
						enabled = ready.isNotBlank() && (ready == held || ready !in setting.options),
						onClick = hapticClick {
							onEdit { if (held != null) it.replaceOption(held, ready) else it.copy(options = it.options + ready) }
							option = ""
							editing = null
						},
					) { Text(if (held != null) "Save" else "Add") }
				}
			} else {
				OutlinedTextField(
					value = setting.default,
					onValueChange = { value -> onEdit { it.copy(default = value) } },
					label = { Text("Default") },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
			}
		}
	}
}
