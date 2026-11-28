package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.FUNCTION_UNLISTED
import com.atelier_nyaarium.switchboard.NoneLine
import com.atelier_nyaarium.switchboard.emptyLine
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.leading
import com.atelier_nyaarium.switchboard.proto.AutomationRow

@Composable
internal fun AutomationsView(
	repo: ChatRepository,
	state: ChatState,
	home: String?,
	/** Session's Gateway first. */
	lead: String?,
	onEdit: (String, AutomationSlot) -> Unit,
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(state.gateways.incarnations()) { repo.automationOps.refreshAll() }
	val groups = leading(automationGroups(state.gateways, state.assistantHome), lead) { it.gatewayId }
	val toggleRefusals by repo.automationOps.toggles.refusals

	PageColumn(modifier) {
		SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
			SegmentedButton(
				selected = !state.automationsMap,
				onClick = hapticClick { repo.showAutomationsAsMap(false) },
				shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
				icon = {},
			) { Text("List") }
			SegmentedButton(
				selected = state.automationsMap,
				onClick = hapticClick { repo.showAutomationsAsMap(true) },
				shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
				icon = {},
			) { Text("Map") }
		}
		automationsEmpty(state.gateways, home)?.let { empty ->
			Text(
				emptyLine(empty, "automations"),
				style = MaterialTheme.typography.bodyLarge,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		if (state.automationsMap) {
			AutomationsMapView(groups) { gatewayId, id -> onEdit(gatewayId, AutomationSlot.Held(id)) }
			return@PageColumn
		}
		for (group in groups) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(group.gatewayId, style = MaterialTheme.typography.labelLarge)
				if (group.assistant) AssistantChip()
			}
			if (group.rows.isEmpty()) NoneLine("automations")
			for (row in group.rows) {
				AutomationRowView(
					row = row,
					served = group.context.served,
					can = opensIn(row, group.context),
					refusal = toggleRefusals[group.gatewayId to row.id],
					onOpen = { onEdit(group.gatewayId, AutomationSlot.Held(row.id)) },
					onToggle = { on -> repo.command { automationOps.setEnabled(group.gatewayId, row, on) } },
				)
			}
		}
	}
}

@Composable
private fun AutomationRowView(
	row: AutomationRow,
	served: Served,
	can: Boolean,
	refusal: String?,
	onOpen: () -> Unit,
	onToggle: (Boolean) -> Unit,
) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	Row(
		Modifier.fillMaxWidth().clickable(enabled = can, onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(row.sentence, style = MaterialTheme.typography.bodyLarge)
			when (val function = rowFunction(row, served)) {
				null -> Text(doesText(row.automation, served), style = MaterialTheme.typography.bodySmall, color = dim)
				is FunctionLine.Named -> FunctionName(function.name, function.count)
				FunctionLine.Unlisted -> Text(FUNCTION_UNLISTED, style = MaterialTheme.typography.bodySmall, color = dim)
				is FunctionLine.Unnamed -> Text(function.does, style = MaterialTheme.typography.bodySmall, color = dim)
			}
			if (rowScriptErrors(row, served)) Text(SCRIPT_ERRORS_LINE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			rowErrorsLine(row)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
			Text(
				row.invalid ?: ranText(row, ::agoText, ::untilText),
				style = MaterialTheme.typography.bodySmall,
				color = if (row.invalid != null) MaterialTheme.colorScheme.error else dim,
			)
			refusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		Switch(checked = row.automation.enabled, onCheckedChange = onToggle, enabled = can)
	}
}
