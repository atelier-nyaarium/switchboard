package com.atelier_nyaarium.switchboard.policies

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.GATEWAY_UNREACHABLE
import com.atelier_nyaarium.switchboard.PolicyDeleted
import com.atelier_nyaarium.switchboard.PolicySaved
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.policyOn
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PolicyEditor(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	policyId: String?,
	onClose: () -> Unit,
) {
	val held: AuthorizationPolicy? = remember(gatewayId, policyId, state.policies) {
		policyId?.let { state.policyOn(gatewayId, it) }
	}
	// The edit lives in the ops class, which outlives the activity.
	val draftKey = policyId ?: "new"
	var draft by remember(gatewayId, policyId) {
		mutableStateOf(
			repo.policyOps.draftFor(gatewayId, draftKey)
				?: held?.let { PolicyDraft.of(it) }
				?: PolicyDraft.fresh(),
		)
	}
	LaunchedEffect(draft) { repo.policyOps.keepDraft(gatewayId, draftKey, draft) }
	val close = {
		repo.policyOps.dropDraft(gatewayId, draftKey)
		onClose()
	}
	val vaultRevision by repo.vault.revision
	// Only what this Gateway may use.
	val entries = remember(vaultRevision, gatewayId) {
		repo.vaultOps.views().filter { it.hasValue && it.allowedOn(gatewayId) }
	}
	val scope = rememberCoroutineScope()
	var example by remember(gatewayId, policyId) { mutableStateOf("") }
	var saving by remember(gatewayId, policyId) { mutableStateOf(false) }
	var refused by remember(gatewayId, policyId) { mutableStateOf<String?>(null) }
	var refusedAt by remember(gatewayId, policyId) { mutableStateOf<Long?>(null) }
	var confirmingDelete by remember(gatewayId, policyId) { mutableStateOf(false) }

	val addExample = {
		draft = draft.withExample(example)
		example = ""
	}
	val commit: () -> Unit = {
		val candidate = draft.toPolicy()
		if (candidate != null) {
			saving = true
			refused = null
			refusedAt = null
			scope.launch {
				when (val saved = repo.policyOps.save(candidate, draft.revision.takeIf { it > 0L }, gatewayId)) {
					is PolicySaved.Refused -> {
						refused = saved.reason
						refusedAt = saved.heldRevision
					}
					PolicySaved.Unreachable -> refused = GATEWAY_UNREACHABLE
					is PolicySaved.Stored -> close()
				}
				saving = false
			}
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (held == null) "New policy" else "Edit policy") },
				actions = {
					TextButton(onClick = hapticClick(close)) { Text("Cancel") }
					Button(
						enabled = draft.refusal() == null && !saving,
						onClick = hapticClick(commit),
						modifier = Modifier.padding(end = 8.dp),
					) { Text(if (saving) "Saving" else "Save") }
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			OutlinedTextField(
				value = draft.name,
				onValueChange = { draft = draft.copy(name = it) },
				label = { Text("Name") },
				supportingText = draft.nameRefusal()?.let { { Text(it) } },
				modifier = Modifier.fillMaxWidth(),
			)

			Text("Secret", style = MaterialTheme.typography.labelLarge)
			if (entries.isEmpty()) {
				Text("None usable on $gatewayId.", style = MaterialTheme.typography.bodySmall)
			}
			draft.bindingRefusal()?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
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
				draft.commandsRefusal() ?: "Kept as the program and its first argument.",
				style = MaterialTheme.typography.bodySmall,
			)
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
				OutlinedTextField(
					value = example,
					onValueChange = { example = it },
					label = { Text("Command") },
					singleLine = true,
					modifier = Modifier.weight(1f),
				)
				TextButton(onClick = hapticClick(addExample), enabled = example.isNotBlank()) { Text("Add") }
			}
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (key in draft.examples) {
					InputChip(
						selected = false,
						onClick = hapticClick { draft = draft.copy(examples = draft.examples - key) },
						label = { Text(key, fontFamily = FontFamily.Monospace) },
						trailingIcon = { Icon(Icons.Default.Close, contentDescription = "Remove") },
					)
				}
			}

			Row(
				Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text(if (draft.enabled) "Enabled" else "Disabled", style = MaterialTheme.typography.bodyMedium)
					Text(
						if (draft.enabled) "Answers these commands from the secret." else "Answers nothing until enabled.",
						style = MaterialTheme.typography.bodySmall,
					)
				}
				Switch(checked = draft.enabled, onCheckedChange = { draft = draft.copy(enabled = it) })
			}

			refused?.let { reason ->
				Card(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(12.dp)) {
						Text(reason, style = MaterialTheme.typography.bodyMedium)
						// An owner tap, as a runbook's overwrite is.
						val over = refusedAt?.let { draft.over(it) }
						if (over != null) {
							TextButton(onClick = hapticClick { draft = over; commit() }) {
								Text("Save over revision ${over.revision}")
							}
						}
					}
				}
			}

			if (held != null) {
				TextButton(onClick = hapticClick { confirmingDelete = true }) { Text("Delete policy") }
			}
		}
	}

	if (confirmingDelete) {
		AlertDialog(
			onDismissRequest = { confirmingDelete = false },
			title = { Text("Delete this policy") },
			text = { Text("Approvals it answered end with it. The secret stays.") },
			confirmButton = {
				TextButton(
					onClick = hapticClick {
						confirmingDelete = false
						scope.launch {
							when (val deleted = repo.policyOps.delete(draft.id, draft.revision, gatewayId)) {
								PolicyDeleted.Deleted -> close()
								is PolicyDeleted.Refused -> refused = deleted.reason
								PolicyDeleted.Unreachable -> refused = GATEWAY_UNREACHABLE
							}
						}
					},
				) { Text("Delete") }
			},
			dismissButton = { TextButton(onClick = hapticClick { confirmingDelete = false }) { Text("Cancel") } },
		)
	}
}
