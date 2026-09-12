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
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.SaveRefusal
import com.atelier_nyaarium.switchboard.RunbookSaved
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.refusalToShow
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunbookEditor(repo: ChatRepository, gatewayId: String, runbookId: String?, onClose: () -> Unit) {
	val existing = remember(gatewayId, runbookId) { runbookId?.let { repo.runbooks.find(gatewayId, it) } }
	val draftKey = runbookId ?: "new"
	var draft by remember(gatewayId, runbookId) {
		mutableStateOf(
			repo.runbookOps.draftFor(gatewayId, draftKey)
				?: existing?.let { RunbookDraft.of(it) }
				?: RunbookDraft(id = newRunbookId()),
		)
	}
	// The repository outlives this activity, so an edit in progress survives a rotation there.
	LaunchedEffect(draft) { repo.runbookOps.keepDraft(gatewayId, draftKey, draft) }
	val declared = draft.declared
	val scope = rememberCoroutineScope()
	var saving by remember(gatewayId, runbookId) { mutableStateOf(false) }
	var refused by remember(gatewayId, runbookId) { mutableStateOf<SaveRefusal?>(null) }
	// Kept with the draft, or a rotation would leave the intent behind and save an ordinary edit.
	var overwriting by rememberSaveable(gatewayId, runbookId) { mutableStateOf(false) }
	var deleting by remember(gatewayId, runbookId) { mutableStateOf(false) }

	EditorScaffold(
		title = if (existing == null) "New runbook" else "Edit runbook",
		saving = saving,
		canSave = draft.refusal() == null,
		onCancel = {
			repo.runbookOps.dropDraft(gatewayId, draftKey)
			onClose()
		},
		onSave = {
			val candidate = draft.toRunbook()
			if (candidate != null) {
				saving = true
				refused = null
				val base = draft.revision.takeIf { it > 0L }
				scope.launch {
					val saved = repo.runbookOps.save(
						candidate,
						gatewayId = gatewayId,
						baseRevision = base,
						overwrite = overwriting,
					)
					when (saved) {
						is RunbookSaved.Refused -> refused = saved.refusal
						else -> {
							repo.runbookOps.dropDraft(gatewayId, draftKey)
							onClose()
						}
					}
					overwriting = false
					saving = false
				}
			}
		},
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

			val shown = if (overwriting) {
				null
			} else {
				refusalToShow(refused, repo.runbookOps.refusalFor(gatewayId, draft.id), draft.revision)
			}
			shown?.let { refusal ->
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
						Text(refusal.reason, style = MaterialTheme.typography.bodyMedium)
						TextButton(
							onClick = hapticClick {
								overwriting = true
								refused = null
							},
						) { Text("Overwrite") }
					}
				}
			}

			if (existing != null) {
				TextButton(onClick = hapticClick { deleting = true }) { Text("Delete runbook") }
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
		AlertDialog(
			onDismissRequest = { deleting = false },
			title = { Text("Delete this runbook") },
			text = {
				Text(
					if (pinning.isEmpty()) {
						"It goes from this Gateway and from this phone."
					} else {
						"It goes, and these routines stop running until you give them another: " +
							pinning.joinToString(", ")
					},
				)
			},
			confirmButton = {
				TextButton(
					onClick = hapticClick {
						deleting = false
						scope.launch {
							// Closing on a delete this Gateway never took would say gone about a copy
							// it still holds.
							if (repo.runbookOps.delete(draft.id, gatewayId)) {
								repo.runbookOps.dropDraft(gatewayId, draftKey)
								onClose()
							} else {
								refused = SaveRefusal("This Gateway still holds it; it was not reached", 0L)
							}
						}
					},
				) { Text("Delete") }
			},
			dismissButton = { TextButton(onClick = hapticClick { deleting = false }) { Text("Cancel") } },
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
