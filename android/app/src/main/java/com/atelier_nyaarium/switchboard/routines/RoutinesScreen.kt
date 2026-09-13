package com.atelier_nyaarium.switchboard.routines

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.GatewayEntry
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.NewOnGatewayFab
import com.atelier_nyaarium.switchboard.ViewScope
import com.atelier_nyaarium.switchboard.groupsOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.routinesOf
import com.atelier_nyaarium.switchboard.proto.RoutineState
import kotlinx.coroutines.launch

@Composable
internal fun RoutinesScreen(
	repo: ChatRepository,
	state: ChatState,
	onEdit: (String, String?) -> Unit,
	modifier: Modifier = Modifier,
	scope: ViewScope = ViewScope.Everything,
) {
	LaunchedEffect(state.gateways.incarnations()) { repo.routineOps.refreshAll() }
	// Every row time is an instant, so it reads in the owner's zone, not its gateway's. The rule
	// keeps its own, and `scheduleLine` names it.
	val zone = java.time.ZoneId.systemDefault()
	val launcher = rememberCoroutineScope()
	val groups = scope.groupsOf(state.gateways.gateways).filter { it.routines != null }
	val named = groups.size > 1
	val toggleRefusals by repo.routineOps.toggleRefusals

	Box(modifier.fillMaxSize()) {
		if (groups.all { scope.routinesOf(it.routines.orEmpty()).isEmpty() }) {
			Column(
				Modifier.fillMaxSize().padding(24.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				Text(emptyTitle(state.gateways, groups), style = MaterialTheme.typography.titleMedium)
			}
		} else {
			LazyColumn(
				modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
				verticalArrangement = Arrangement.spacedBy(10.dp),
				contentPadding = PaddingValues(top = 12.dp, bottom = 88.dp),
			) {
				for (group in groups) {
					// Named only when there is more than one, so a single-gateway phone gains no words.
					if (named) {
						item(key = "gateway:${group.id}") {
							Text(
								group.id,
								style = MaterialTheme.typography.labelLarge,
								modifier = Modifier.padding(top = 6.dp),
							)
						}
					}
					for (row in scope.routinesOf(group.routines.orEmpty())) {
						item(key = "routine:${group.id}:${row.routine.id}") {
							RoutineRow(
								row = row,
								zone = zone,
								onEdit = { onEdit(group.id, row.routine.id) },
								onRun = {
									launcher.launch { repo.routineOps.run(row.routine.id, group.id) }
								},
								toggleRefusal = toggleRefusals[group.id to row.routine.id],
								onEnable = { on ->
									launcher.launch {
										repo.routineOps.setEnabled(row.routine.id, on, row.routine.revision, group.id)
									}
								},
								onRunNow = { occurrenceId ->
									launcher.launch {
										repo.routineOps.runNow(row.routine.id, occurrenceId, group.id)
									}
								},
								onDismiss = { occurrenceId ->
									launcher.launch {
										repo.routineOps.dismiss(row.routine.id, occurrenceId, group.id)
									}
								},
							)
						}
					}
				}
			}
		}
		NewOnGatewayFab(
			registry = state.gateways,
			description = "New routine",
			onNew = { onEdit(it, null) },
			modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
			scope = scope,
		)
	}
}

/** A gateway that answered and holds nothing is not the same as one that could not be read. */
private fun emptyTitle(registry: GatewayRegistry, groups: List<GatewayEntry>): String = when {
	!registry.loaded -> "No roster yet"
	groups.isEmpty() -> "No Gateway could be read"
	else -> "No routines"
}

@Composable
private fun RoutineRow(
	row: RoutineState,
	zone: java.time.ZoneId,
	toggleRefusal: String?,
	onEdit: () -> Unit,
	onRun: () -> Unit,
	onEnable: (Boolean) -> Unit,
	onRunNow: (String) -> Unit,
	onDismiss: (String) -> Unit,
) {
	Card(Modifier.fillMaxWidth().clickable(onClick = hapticClick(onEdit))) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(
				Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text(row.routine.name, style = MaterialTheme.typography.titleMedium)
					Text(
						scheduleLine(row.routine),
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
				}
				// Enabled while disabled: the switch stops the schedule, not the routine.
				TextButton(onClick = hapticClick(onRun)) { Text("Run") }
				Switch(checked = row.routine.enabled, onCheckedChange = onEnable)
			}
			Text(
				nextRunLine(row.routine, row.nextAt, zone),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			// Held state, and why it did not move.
			toggleRefusal?.let { Panel(it) }
			lastRunLine(row, zone)?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			row.reviewAt?.let { Panel(reviewLine(it, zone)) }
			row.attention?.let { wanted ->
				// Linking is the owner's other answer, and the editor is where it is given.
				Panel(attentionLine(wanted, zone)) {
					TextButton(onClick = hapticClick(onEdit)) { Text("Link the secret") }
				}
			}
			row.missed?.let { miss ->
				Panel("${missLine(miss, zone)} $DISMISS_EXPLAINS") {
					if (miss.runnable) {
						TextButton(onClick = hapticClick { onRunNow(miss.occurrenceId) }) { Text("Run missed") }
					}
					TextButton(onClick = hapticClick { onDismiss(miss.occurrenceId) }) { Text("Dismiss") }
				}
			}
		}
	}
}

/** Outlined against the row it sits in: a card inside a card of the same tone reads as body text. */
@Composable
private fun Panel(text: String, actions: @Composable (() -> Unit)? = null) {
	OutlinedCard(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
			Text(text, style = MaterialTheme.typography.bodySmall)
			if (actions != null) {
				Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { actions() }
			}
		}
	}
}
