package com.atelier_nyaarium.switchboard.policies

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.EditKey
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.EditorWaiting
import com.atelier_nyaarium.switchboard.EditStanding
import com.atelier_nyaarium.switchboard.MirroredDraft
import com.atelier_nyaarium.switchboard.RemoveMenu
import com.atelier_nyaarium.switchboard.editStanding
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.openingDraft
import com.atelier_nyaarium.switchboard.rememberEdit
import com.atelier_nyaarium.switchboard.vault.grantableOn

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PolicyEditor(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	policyId: String?,
) {
	val lookup = remember(gatewayId, policyId, state.gateways) {
		policyId?.let { state.gateways.policyOn(gatewayId, it) }
	}
	// The edit lives in the ops class, which outlives the activity.
	val edits = repo.policyOps.edits
	val key = EditKey(gatewayId, policyId)
	val fresh = remember(key, lookup) { openingDraft(lookup, PolicyDraft::fresh, PolicyDraft::of) }
	val standing = editStanding(lookup)
	if (standing == EditStanding.READING || standing == EditStanding.UNREACHABLE) {
		LaunchedEffect(gatewayId) { repo.command { policyOps.refresh(gatewayId) } }
	}
	val open = rememberEdit(edits, key, standing, fresh) { EditorWaiting("Edit policy", it, edits::hide) } ?: return
	val opening = open.opening
	val session = open.session
	val typed = remember(key, opening) { MirroredDraft(session.draft) { next -> edits.edit(key, opening) { next } } }
	var draft by typed
	// Typed while its op was out.
	LaunchedEffect(session.busy) { if (!session.busy) edits.edit(key, opening) { draft } }
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision, gatewayId) { repo.vaultOps.views().grantableOn(gatewayId) }
	var example by remember(gatewayId, policyId) { mutableStateOf("") }
	var editing by remember(gatewayId, policyId) { mutableStateOf<String?>(null) }
	val saving = session.busy
	val refused = session.said?.reason
	val refusedAt = session.said?.heldRevision
	val marked = session.said?.marks
	var confirmingDelete by remember(gatewayId, policyId) { mutableStateOf(false) }

	val addExample = {
		val held = editing
		draft = if (held != null) draft.replaceExample(held, example) else draft.withExample(example)
		example = ""
		editing = null
	}
	// Sends what is typed now, on a scope that outlives this page.
	val commit: (PolicyDraft) -> Unit = { sent ->
		edits.edit(key, opening) { sent }
		repo.command { policyOps.commit(key, opening) }
	}

	EditorScaffold(
		title = if (policyId == null) "New policy" else "Edit policy",
		saving = saving,
		canSave = draft.toPolicy() != null,
		menu = { if (policyId != null) RemoveMenu("Delete policy", enabled = !saving) { confirmingDelete = true } },
		onBack = { repo.editors.askLeave() },
		onSave = { commit(draft) },
		leaving = open.leaving,
	) {
			refused?.let { reason ->
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(12.dp)) {
						Text(reason, style = MaterialTheme.typography.bodyMedium)
						// An owner tap, as a runbook's overwrite is.
						val over = draft.saveOver(lookup, refusedAt)
						if (over != null && !saving) {
							TextButton(onClick = hapticClick { draft = over; commit(over) }) {
								Text("Save over revision ${over.revision}")
							}
						}
					}
				}
			}

			OutlinedTextField(
				value = draft.name,
				onValueChange = { draft = draft.copy(name = it) },
				label = { Text("Name") },
				modifier = Modifier.fillMaxWidth(),
			)

			Text("Secret", style = MaterialTheme.typography.labelLarge)
			if (entries.isEmpty()) {
				Text("None usable on $gatewayId.", style = MaterialTheme.typography.bodySmall)
			}
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (entry in entries) {
					FilterChip(
						selected = draft.entryId == entry.id,
						onClick = hapticClick { draft = draft.copy(entryId = entry.id) },
						label = { Text(entry.title) },
					)
				}
			}
			// Kept and named, never dropped.
			if (draft.entryId.isNotBlank() && entries.none { it.id == draft.entryId }) {
				Text(
					"Bound to ${draft.entryId}, which $gatewayId may not use.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.error,
				)
			}

			Text("Commands", style = MaterialTheme.typography.labelLarge)
			Text(
				buildAnnotatedString {
					append("Example: ")
					withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("sudo apt-get") }
				},
				style = MaterialTheme.typography.bodySmall,
			)
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
				OutlinedTextField(
					value = example,
					onValueChange = { example = it },
					label = { Text("Command") },
					singleLine = true,
					keyboardOptions = EXACT_KEYBOARD,
					modifier = Modifier.weight(1f),
				)
				TextButton(onClick = hapticClick(addExample), enabled = example.isNotBlank()) {
					Text(if (editing != null) "Save" else "Add")
				}
			}
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (key in draft.examples) {
					InputChip(
						selected = editing == key,
						// Tap edits; the X removes.
						onClick = hapticClick {
							editing = key
							example = key
						},
						label = { Text(key, fontFamily = FontFamily.Monospace) },
						// Refused command.
						colors = if (key == marked) {
							InputChipDefaults.inputChipColors(
								containerColor = MaterialTheme.colorScheme.errorContainer,
								labelColor = MaterialTheme.colorScheme.onErrorContainer,
							)
						} else {
							InputChipDefaults.inputChipColors()
						},
						trailingIcon = {
							IconButton(onClick = hapticClick {
								draft = draft.copy(examples = draft.examples - key)
								if (editing == key) {
									editing = null
									example = ""
								}
							}) { Icon(Icons.Default.Close, contentDescription = "Remove $key") }
						},
					)
				}
			}
	}

	if (confirmingDelete) {
		ConfirmDialog(
			title = "Delete this policy?",
			body = "Approvals it answered end with it. The secret stays.",
			confirmText = "Delete",
			onConfirm = {
				confirmingDelete = false
				repo.command { policyOps.remove(key, opening) }
			},
			onDismiss = { confirmingDelete = false },
		)
	}
}
