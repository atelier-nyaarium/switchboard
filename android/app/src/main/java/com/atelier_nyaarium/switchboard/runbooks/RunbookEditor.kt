package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import com.atelier_nyaarium.switchboard.SaveRefusal
import com.atelier_nyaarium.switchboard.RunbookSaved
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.refusalToShow
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunbookEditor(repo: ChatRepository, runbookId: String?, onClose: () -> Unit) {
	val existing = remember(runbookId) { runbookId?.let { repo.runbooks.find(it) } }
	val draftKey = runbookId ?: "new"
	var draft by remember(runbookId) {
		mutableStateOf(
			repo.runbookOps.draftFor(draftKey)
				?: existing?.let { RunbookDraft.of(it) }
				?: RunbookDraft(id = newRunbookId()),
		)
	}
	// The repository outlives this activity, so an edit in progress survives a rotation there.
	LaunchedEffect(draft) { repo.runbookOps.keepDraft(draftKey, draft) }
	val declared = draft.declared
	val scope = rememberCoroutineScope()
	var saving by remember(runbookId) { mutableStateOf(false) }
	var refused by remember(runbookId) { mutableStateOf<SaveRefusal?>(null) }
	// Kept with the draft, or a rotation would leave the intent behind and save an ordinary edit.
	var overwriting by rememberSaveable(runbookId) { mutableStateOf(false) }

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (existing == null) "New runbook" else "Edit runbook") },
				actions = {
					TextButton(
						onClick = hapticClick {
							repo.runbookOps.dropDraft(draftKey)
							onClose()
						},
					) { Text("Cancel") }
					Button(
						enabled = draft.refusal() == null && !saving,
						onClick = hapticClick {
							val candidate = draft.toRunbook() ?: return@hapticClick
							saving = true
							refused = null
							val base = draft.revision.takeIf { it > 0L }
							scope.launch {
								when (val saved = repo.runbookOps.save(candidate, baseRevision = base, overwrite = overwriting)) {
									is RunbookSaved.Refused -> refused = saved.refusal
									else -> {
										repo.runbookOps.dropDraft(draftKey)
										onClose()
									}
								}
								overwriting = false
								saving = false
							}
						},
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
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)
			OutlinedTextField(
				value = draft.body,
				onValueChange = { draft = draft.copy(body = it) },
				label = { Text("Body") },
				supportingText = { Text("{{name}} makes a blank") },
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
				refusalToShow(refused, repo.runbookOps.refusalFor(draft.id), draft.revision)
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

			draft.refusal()?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
			Spacer(Modifier.height(24.dp))
		}
	}
}

@Composable
private fun ParameterCard(name: String, setting: ParameterDraft, onEdit: ((ParameterDraft) -> ParameterDraft) -> Unit) {
	var option by remember(name) { mutableStateOf("") }

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
						InputChip(
							selected = setting.default == held,
							onClick = hapticClick { onEdit { it.copy(default = if (it.default == held) "" else held) } },
							label = { Text(shown, maxLines = 1, overflow = TextOverflow.Ellipsis) },
							trailingIcon = {
								IconButton(onClick = hapticClick {
									onEdit { it.copy(options = it.options - held, default = if (it.default == held) "" else it.default) }
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
					TextButton(
						enabled = ready.isNotBlank() && ready !in setting.options,
						onClick = hapticClick {
							onEdit { it.copy(options = it.options + ready) }
							option = ""
						},
					) { Text("Add") }
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
