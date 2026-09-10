package com.atelier_nyaarium.switchboard.routines

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.RoutineSaved
import com.atelier_nyaarium.switchboard.absoluteTimeText
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Routine
import kotlinx.coroutines.launch

private val WEEKDAY_LABELS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineEditor(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	routineId: String?,
	onClose: () -> Unit,
) {
	// Routine and pinned runbook share a Gateway.
	val group = remember(gatewayId, state.gateways) { state.gateways.entry(gatewayId) }
	val held: Routine? = remember(gatewayId, routineId, state.gateways) {
		routineId?.let { state.gateways.routineOn(gatewayId, it)?.routine }
	}
	val zone = remember { java.time.ZoneId.systemDefault() }
	val gatewayZone = group?.routineZone.orEmpty().ifBlank { zone.id }
	// Read in the owner's own zone, whatever the gateway keeps it in.
	var draft by remember(routineId, gatewayZone) {
		mutableStateOf(
			held?.let { RoutineDraft.of(it).shown(zone.id) }
				?: RoutineDraft(
					id = "routine-${java.util.UUID.randomUUID().toString().take(8)}",
					startDate = java.time.LocalDate.now(zone).toString(),
					zone = zone.id,
				),
		)
	}
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }
	val scope = rememberCoroutineScope()
	var saving by remember(routineId) { mutableStateOf(false) }
	var refused by remember(routineId) { mutableStateOf<String?>(null) }
	var confirming by remember(routineId) { mutableStateOf(false) }
	var confirmingDelete by remember(routineId) { mutableStateOf(false) }

	// On an untouched form the switch is the row's, so it writes without a Save.
	val flip: (Boolean) -> Unit = { on ->
		val opened = draft
		draft = draft.copy(enabled = on)
		if (opened.flipsAtOnce(held, zone.id)) {
			refused = null
			scope.launch {
				when (val saved = repo.routineOps.setEnabled(opened.id, on, opened.revision, gatewayId)) {
					is RoutineSaved.Stored -> draft = RoutineDraft.of(saved.routine).shown(zone.id)
					is RoutineSaved.Refused -> {
						draft = opened
						refused = saved.reason
					}
					RoutineSaved.Unreachable -> {
						draft = opened
						refused = com.atelier_nyaarium.switchboard.GATEWAY_UNREACHABLE
					}
				}
			}
		}
	}
	val commit: () -> Unit = {
		// Converted here and nowhere else: what the gateway stores is its own zone's wall clock.
		val candidate = draft.asKept(gatewayZone).toRoutine()
		if (candidate != null) {
			saving = true
			refused = null
			scope.launch {
				when (val saved = repo.routineOps.save(candidate, draft.revision.takeIf { it > 0L }, gatewayId)) {
					is RoutineSaved.Refused -> refused = saved.reason
					RoutineSaved.Unreachable -> refused = com.atelier_nyaarium.switchboard.GATEWAY_UNREACHABLE
					is RoutineSaved.Stored -> onClose()
				}
				saving = false
			}
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (held == null) "New routine" else "Edit routine") },
				actions = {
					TextButton(onClick = hapticClick(onClose)) { Text("Cancel") }
					Button(
						enabled = draft.refusal() == null && !saving,
						onClick = hapticClick { if (ruleMoved(held, draft)) confirming = true else commit() },
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
			Row(
				Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				// The state it is in, not the move.
				Text(
					if (draft.enabled) "Enabled" else "Disabled",
					style = MaterialTheme.typography.bodyMedium,
					modifier = Modifier.weight(1f),
				)
				Switch(checked = draft.enabled, onCheckedChange = flip)
			}

			refused?.let {
				Card(Modifier.fillMaxWidth()) {
					Text(it, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
				}
			}

			OutlinedTextField(
				value = draft.name,
				onValueChange = { draft = draft.copy(name = it) },
				label = { Text("Name") },
				modifier = Modifier.fillMaxWidth(),
			)

			Text("Schedule", style = MaterialTheme.typography.labelLarge)
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				WEEKDAY_LABELS.forEachIndexed { index, label ->
					val day = index + 1
					FilterChip(
						selected = day in draft.weekdays,
						onClick = hapticClick {
							draft = draft.copy(
								weekdays = if (day in draft.weekdays) draft.weekdays - day else draft.weekdays + day,
							)
						},
						label = { Text(label) },
					)
				}
			}
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				OutlinedTextField(
					value = draft.time,
					onValueChange = { draft = draft.copy(time = it) },
					label = { Text("Time") },
					modifier = Modifier.weight(1f),
				)
				OutlinedTextField(
					value = draft.weekInterval.toString(),
					onValueChange = { text -> text.toIntOrNull()?.let { draft = draft.copy(weekInterval = it) } },
					label = { Text("Every N weeks") },
					modifier = Modifier.weight(1f),
				)
			}
			// No zone picker: the gateway's zone is canonical, so the owner reads their own and the
			// save converts. Saying so beats a field that looks like a choice and is not one.
			if (zone.id != gatewayZone) {
				Text(
					"Shown in your time. Kept as $gatewayZone.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}

			Text("Runbook", style = MaterialTheme.typography.labelLarge)
			// This gateway's only. A routine cannot pin words another machine holds.
			val library = remember(gatewayId, state.gateways) { state.gateways.runbooksOn(gatewayId) }
			val names = library.map { it.name }
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (book in library) {
					FilterChip(
						selected = draft.runbookId == book.id,
						onClick = hapticClick {
							draft = draft.copy(runbookId = book.id, approvedRevision = book.revision)
						},
						label = { Text(runbookChipLabel(book.name, book.id, names)) },
					)
				}
			}
			val picked = library.find { it.id == draft.runbookId }
			for (parameter in picked?.parameters.orEmpty()) {
				val held = draft.values[parameter.name].orEmpty()
				val set = { value: String -> draft = draft.copy(values = draft.values + (parameter.name to value)) }
				// A choice offers what the runbook offers, as the fire sheet does. A free field here
				// would take a value the runbook never named and only fail at the gateway.
				if (parameter.kind == "choice") {
					Text(parameter.label, style = MaterialTheme.typography.labelLarge)
					FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
						for (option in parameter.options.orEmpty()) {
							FilterChip(
								selected = held == option,
								onClick = hapticClick { set(option) },
								label = { Text(option) },
							)
						}
					}
				} else {
					OutlinedTextField(
						value = held,
						onValueChange = set,
						label = { Text(parameter.label) },
						modifier = Modifier.fillMaxWidth(),
					)
				}
			}

			OutlinedTextField(
				value = draft.spawn,
				onValueChange = { draft = draft.copy(spawn = it) },
				label = { Text("Spawn point") },
				modifier = Modifier.fillMaxWidth(),
			)

			Text("Linked secrets", style = MaterialTheme.typography.labelLarge)
			Text(
				if (entries.isEmpty()) {
					"Nothing in the vault to link yet."
				} else {
					"Each is unrestricted while this routine is working: it may be used for anything " +
						"the session can be talked into running."
				},
				style = MaterialTheme.typography.bodySmall,
			)
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (entry in entries) {
					FilterChip(
						selected = entry.id in draft.linkedEntries,
						onClick = hapticClick {
							draft = draft.copy(
								linkedEntries = if (entry.id in draft.linkedEntries) {
									draft.linkedEntries - entry.id
								} else {
									draft.linkedEntries + entry.id
								},
							)
						},
						label = { Text(entry.title) },
					)
				}
			}

			if (held != null) {
				TextButton(onClick = hapticClick { confirmingDelete = true }) { Text("Delete routine") }
			}
		}
	}

	if (confirming) {
		val kept = remember(draft, gatewayZone) { draft.asKept(gatewayZone).toRoutine() }
		// The instant comes from the gateway: recurrence has one implementation and it is not here.
		// Saving waits for it, since a confirmation that cannot name the run is not one.
		var asked by remember(kept) { mutableStateOf(false) }
		var next by remember(kept) { mutableStateOf<Long?>(null) }
		LaunchedEffect(kept) {
			if (kept == null) return@LaunchedEffect
			next = repo.routineOps.nextRun(kept, gatewayId)
			asked = true
		}
		AlertDialog(
			onDismissRequest = { confirming = false },
			title = { Text("The schedule moves") },
			text = {
				Text(
					when {
						kept == null -> VERBS_EXPLAIN
						!asked -> "It becomes ${scheduleLine(kept)}. Working out when it next runs."
						next == null -> "It becomes ${scheduleLine(kept)}, and names no run. $VERBS_EXPLAIN"
						else ->
							"It becomes ${scheduleLine(kept)}, next running " +
								"${absoluteTimeText(next!!, zone)}. $VERBS_EXPLAIN"
					},
				)
			},
			confirmButton = {
				TextButton(
					enabled = kept == null || asked,
					onClick = hapticClick {
						confirming = false
						commit()
					},
				) { Text("Save") }
			},
			dismissButton = { TextButton(onClick = hapticClick { confirming = false }) { Text("Cancel") } },
		)
	}

	if (confirmingDelete) {
		AlertDialog(
			onDismissRequest = { confirmingDelete = false },
			title = { Text("Delete this routine") },
			text = { Text("$DELETE_EXPLAINS $VERBS_EXPLAIN") },
			confirmButton = {
				TextButton(
					onClick = hapticClick {
						confirmingDelete = false
						scope.launch {
							if (repo.routineOps.delete(draft.id, gatewayId)) {
								onClose()
							} else {
								refused = "This Gateway still runs it; it was not reached"
							}
						}
					},
				) { Text("Delete") }
			},
			dismissButton = { TextButton(onClick = hapticClick { confirmingDelete = false }) { Text("Cancel") } },
		)
	}
}
