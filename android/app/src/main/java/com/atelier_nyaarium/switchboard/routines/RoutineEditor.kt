package com.atelier_nyaarium.switchboard.routines

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.NO_TAP_AWAY
import com.atelier_nyaarium.switchboard.RoutineSaved
import com.atelier_nyaarium.switchboard.absoluteTimeText
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.runbooks.PickMenu
import com.atelier_nyaarium.switchboard.runbooks.PreviewPane
import com.atelier_nyaarium.switchboard.runbooks.PreviewState
import com.atelier_nyaarium.switchboard.runbooks.settledPreview
import com.atelier_nyaarium.switchboard.runbooks.spawnChoices
import com.atelier_nyaarium.switchboard.runbooks.spawnMenu
import com.atelier_nyaarium.switchboard.runbooks.stale
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
	val offered = remember(entries, gatewayId) { entries.filter { it.hasValue && it.allowedOn(gatewayId) } }
	val scope = rememberCoroutineScope()
	var saving by remember(routineId) { mutableStateOf(false) }
	var refused by remember(routineId) { mutableStateOf<String?>(null) }
	var confirming by remember(routineId) { mutableStateOf(false) }
	var confirmingDelete by remember(routineId) { mutableStateOf(false) }
	var granting by remember(routineId) { mutableStateOf(false) }
	var pickingTime by remember(routineId) { mutableStateOf(false) }

	// This gateway's only. A routine cannot pin words another machine holds.
	val library = remember(gatewayId, state.gateways) { state.gateways.runbooksOn(gatewayId) }
	val names = library.map { it.name }
	val picked = library.find { it.id == draft.runbookId }
	val books = remember(library, draft.runbookId, draft.approvedRevision) {
		runbookMenu(library, draft.runbookId, draft.approvedRevision)
	}
	val spawns = remember(state, gatewayId, draft.spawn) { spawnMenu(spawnChoices(state, gatewayId), draft.spawn) }

	var preview by remember(routineId) { mutableStateOf<PreviewState>(PreviewState.Pending) }
	var attempt by remember(routineId) { mutableStateOf(0) }
	// Keyed on the library's copy too, or a runbook that lands after the routine never renders.
	LaunchedEffect(draft.runbookId, picked?.revision, draft.values, attempt) {
		val book = picked ?: return@LaunchedEffect
		preview = preview.stale()
		preview = settledPreview(repo, gatewayId, book.id, draft.values, book.revision)
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
			Modifier.padding(pad).fillMaxSize().imePadding().verticalScroll(rememberScrollState())
				.padding(horizontal = 16.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
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
				Box(Modifier.weight(1f)) {
					OutlinedTextField(
						value = draft.time,
						onValueChange = {},
						readOnly = true,
						label = { Text("Time") },
						modifier = Modifier.fillMaxWidth(),
					)
					Box(Modifier.matchParentSize().clickable(onClick = hapticClick { pickingTime = true }))
				}
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

			PickMenu(
				label = "Spawn point",
				choices = spawns,
				picked = spawns.find { it.spawn == draft.spawn },
				labelOf = { it.label },
				onPick = { draft = draft.copy(spawn = it.spawn) },
				trailingOf = { if (it.offered) null else "not offered now" },
			)

			Text("Granted secrets", style = MaterialTheme.typography.labelLarge)
			Text(grantedLine(draft.linkedEntries, entries), style = MaterialTheme.typography.bodyMedium)
			OutlinedButton(onClick = hapticClick { granting = true }) { Text("Grant secrets") }

			PickMenu(
				label = "Runbook",
				choices = books,
				picked = books.find { it.id == draft.runbookId },
				labelOf = { runbookChipLabel(it.name, it.id, names) },
				onPick = { draft = draft.pickRunbook(it) },
				trailingOf = { book -> if (library.any { it.id == book.id }) null else "not stored now" },
			)
			for (parameter in picked?.parameters.orEmpty()) {
				val value = draft.values[parameter.name].orEmpty()
				val set = { text: String -> draft = draft.copy(values = draft.values + (parameter.name to text)) }
				// A choice offers what the runbook offers, as the fire sheet does. A free field here
				// would take a value the runbook never named and only fail at the gateway.
				if (parameter.kind == "choice") {
					Text(parameter.label, style = MaterialTheme.typography.labelLarge)
					FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
						for (option in parameter.options.orEmpty()) {
							FilterChip(
								selected = value == option,
								onClick = hapticClick { set(option) },
								label = { Text(option) },
							)
						}
					}
				} else {
					OutlinedTextField(
						value = value,
						onValueChange = set,
						label = { Text(parameter.label) },
						modifier = Modifier.fillMaxWidth(),
					)
				}
			}
			if (picked != null) {
				PreviewPane(preview) {
					scope.launch {
						repo.runbookOps.overwrite(draft.runbookId, gatewayId)
						attempt += 1
					}
				}
			}

			if (held != null) {
				TextButton(onClick = hapticClick { confirmingDelete = true }) { Text("Delete routine") }
			}
		}
	}

	if (pickingTime) {
		val (hour, minute) = clockOf(draft.time)
		val clock = rememberTimePickerState(
			initialHour = hour,
			initialMinute = minute,
			is24Hour = android.text.format.DateFormat.is24HourFormat(LocalContext.current),
		)
		Dialog(onDismissRequest = { pickingTime = false }, properties = NO_TAP_AWAY) {
			Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
				Column(
					Modifier.padding(24.dp),
					horizontalAlignment = Alignment.CenterHorizontally,
					verticalArrangement = Arrangement.spacedBy(20.dp),
				) {
					Text("Time", style = MaterialTheme.typography.titleMedium)
					TimePicker(state = clock)
					Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
						TextButton(onClick = hapticClick { pickingTime = false }) { Text("Cancel") }
						TextButton(
							onClick = hapticClick {
								draft = draft.copy(time = clockText(clock.hour, clock.minute))
								pickingTime = false
							},
						) { Text("OK") }
					}
				}
			}
		}
	}

	if (granting) {
		GrantSecretsSheet(
			entries = offered,
			granted = draft.linkedEntries,
			onDone = {
				draft = draft.copy(linkedEntries = it)
				granting = false
			},
			onDismiss = { granting = false },
		)
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
