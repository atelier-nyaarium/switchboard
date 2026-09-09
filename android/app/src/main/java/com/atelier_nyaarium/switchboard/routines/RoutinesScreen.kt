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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Card
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.RoutineState
import kotlinx.coroutines.launch

@Composable
fun RoutinesScreen(
	repo: ChatRepository,
	state: ChatState,
	onEdit: (String?) -> Unit,
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(state.homeGatewayId) { repo.routineOps.refresh() }
	val zone = java.time.ZoneId.systemDefault()
	val scope = rememberCoroutineScope()

	Box(modifier.fillMaxSize()) {
		if (state.routines.isEmpty()) {
			Column(
				Modifier.fillMaxSize().padding(24.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				Text("No routines", style = MaterialTheme.typography.titleMedium)
				Text(
					"A routine fires a runbook on a schedule, in a session of its own.",
					style = MaterialTheme.typography.bodySmall,
				)
			}
		} else {
			LazyColumn(
				modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
				verticalArrangement = Arrangement.spacedBy(10.dp),
				contentPadding = PaddingValues(top = 12.dp, bottom = 88.dp),
			) {
				for (row in state.routines) {
					item(key = "routine:${row.routine.id}") {
						RoutineRow(
							row = row,
							zone = zone,
							onEdit = { onEdit(row.routine.id) },
							onEnable = { on -> scope.launch { repo.routineOps.setEnabled(row.routine.id, on) } },
							onRunNow = { occurrenceId ->
								scope.launch { repo.routineOps.runNow(row.routine.id, occurrenceId) }
							},
							onDismiss = { occurrenceId ->
								scope.launch { repo.routineOps.dismiss(row.routine.id, occurrenceId) }
							},
						)
					}
				}
			}
		}
		FloatingActionButton(
			onClick = hapticClick { onEdit(null) },
			modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
		) { Icon(Icons.Default.Add, contentDescription = "New routine") }
	}
}

@Composable
private fun RoutineRow(
	row: RoutineState,
	zone: java.time.ZoneId,
	onEdit: () -> Unit,
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
				Switch(checked = row.routine.enabled, onCheckedChange = onEnable)
			}
			Text(
				nextRunLine(row.routine, row.nextAt, zone),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			row.reviewAt?.let { Panel(reviewLine(it, zone)) }
			row.attention?.let { Panel(attentionLine(it, zone)) }
			row.missed?.let { miss ->
				Panel(missLine(miss, zone)) {
					if (miss.runnable) {
						TextButton(onClick = hapticClick { onRunNow(miss.occurrenceId) }) { Text("Run now") }
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
