package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.NewOnGatewayFab
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Runbook

@Composable
fun RunbooksScreen(
	repo: ChatRepository,
	state: ChatState,
	onFire: (String, String) -> Unit,
	onEdit: (String, String?) -> Unit,
	modifier: Modifier = Modifier,
) {
	val gateways = state.admittedGateways
	LaunchedEffect(gateways) { repo.runbookOps.refreshAll(gateways) }
	val groups = state.runbooks
	val named = groups.size > 1

	Box(modifier.fillMaxSize()) {
		if (groups.all { it.runbooks.isEmpty() }) {
			Column(
				Modifier.fillMaxSize().padding(24.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				// A gateway that answered and holds nothing is not one that could not be read.
				val title = if (groups.isEmpty()) "No Gateway could be read" else "No runbooks"
				Text(title, style = MaterialTheme.typography.titleMedium)
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
						item(key = "gateway:${group.gatewayId}") {
							Text(
								group.gatewayId,
								style = MaterialTheme.typography.labelLarge,
								modifier = Modifier.padding(top = 6.dp),
							)
						}
					}
					for (runbook in group.runbooks) {
						item(key = "runbook:${group.gatewayId}:${runbook.id}") {
							RunbookRow(
								runbook,
								onFire = { onFire(group.gatewayId, runbook.id) },
								onEdit = { onEdit(group.gatewayId, runbook.id) },
							)
						}
					}
				}
			}
		}
		NewOnGatewayFab(
			gateways = gateways,
			description = "New runbook",
			onNew = { onEdit(it, null) },
			modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
		)
	}
}

@Composable
private fun RunbookRow(runbook: Runbook, onFire: () -> Unit, onEdit: () -> Unit) {
	Card(Modifier.fillMaxWidth().clickable(onClick = hapticClick(onEdit))) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(
				Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text(runbook.name, style = MaterialTheme.typography.titleMedium)
					Text(
						summaryOf(runbook.body),
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
				}
				Button(onClick = hapticClick(onFire)) { Text("Fire") }
			}
			if (runbook.parameters.isNotEmpty()) {
				FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
					for (parameter in runbook.parameters) {
						AssistChip(
							onClick = {},
							enabled = false,
							label = { Text(parameter.label) },
							colors = AssistChipDefaults.assistChipColors(),
						)
					}
				}
			}
		}
	}
}
