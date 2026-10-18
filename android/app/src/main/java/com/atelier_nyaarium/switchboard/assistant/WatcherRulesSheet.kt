package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.atelier_nyaarium.switchboard.AssistantAnswer
import com.atelier_nyaarium.switchboard.AssistantOps
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.answerText
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val PREVIEW_DEBOUNCE_MS = 400L

/** Ordered watcher rules. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WatcherRulesSheet(ops: AssistantOps, gatewayId: String, watcher: AssistantWatcher, onDismiss: () -> Unit) {
	val rules = rulesOf(watcher) ?: return
	val scope = rememberCoroutineScope()
	var editing by remember { mutableStateOf<RuleSlot?>(null) }
	var busy by remember { mutableStateOf(false) }
	var said by remember { mutableStateOf<String?>(null) }

	ModalBottomSheet(onDismissRequest = onDismiss) {
		Column(
			Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(8.dp),
		) {
			Text(watcher.label, style = MaterialTheme.typography.titleLarge)
			Text(
				"First match wins.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			rules.held.rules.forEachIndexed { index, rule ->
				val raise = raised(rules.held, index)?.takeIf { !busy }
				RuleRow(
					number = "${index + 1}",
					text = ruleSummary(rule),
					action = rule.action,
					pings = rowPings(rule.action, rule.ping, rules.pingDefault),
					onOpen = { editing = RuleSlot.At(index) },
					onRaise = raise?.let { put ->
						{
							busy = true
							scope.launch {
								said = answerText(ops.putRules(gatewayId, watcher.id, put))
								busy = false
							}
						}
					},
				)
			}
			val otherwise = rules.held.otherwise
			RuleRow(
				number = "·",
				text = "Anything else",
				action = otherwise.action,
				pings = rowPings(otherwise.action, otherwise.ping, rules.pingDefault),
				onOpen = { editing = RuleSlot.Otherwise },
				onRaise = null,
			)
			TextButton(
				onClick = hapticClick { editing = RuleSlot.New },
				enabled = !busy && rules.held.rules.size < MAX_RULES,
			) { Text("+ Add rule") }
			val dropped = watcher.dropped ?: 0L
			if (dropped > 0L) {
				Text(
					"$dropped dropped in the last 7 days",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
	}

	editing?.let { slot ->
		RuleEditorSheet(
			ops = ops,
			gatewayId = gatewayId,
			watcher = watcher,
			rules = rules,
			slot = slot,
			onDone = {
				editing = null
				said = null
			},
			onDismiss = { editing = null },
		)
	}
}

@Composable
private fun RuleRow(
	number: String,
	text: String,
	action: String,
	pings: Boolean,
	onOpen: () -> Unit,
	onRaise: (() -> Unit)?,
) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Text(
			number,
			Modifier.width(20.dp),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
		if (pings) {
			Icon(Icons.Default.NotificationsActive, contentDescription = "Pings", tint = MaterialTheme.colorScheme.tertiary)
		}
		Text(actionLabel(action), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
		if (onRaise != null) {
			IconButton(onClick = hapticClick(onRaise)) { Icon(Icons.Default.ArrowUpward, contentDescription = "Move up") }
		} else {
			Box(Modifier.width(48.dp))
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RuleEditorSheet(
	ops: AssistantOps,
	gatewayId: String,
	watcher: AssistantWatcher,
	rules: WatcherRules,
	slot: RuleSlot,
	onDone: () -> Unit,
	onDismiss: () -> Unit,
) {
	val scope = rememberCoroutineScope()
	/** The base a save names. */
	var opened by remember(slot) { mutableStateOf(rules) }
	var draft by remember(slot) { mutableStateOf(RuleDraft.of(slot, rules)) }
	var busy by remember { mutableStateOf(false) }
	var said by remember { mutableStateOf<String?>(null) }
	var preview by remember { mutableStateOf<String?>(null) }
	val rule = draft.toRule()

	if (slot != RuleSlot.Otherwise) {
		LaunchedEffect(rule) {
			preview = null
			val asked = rule ?: return@LaunchedEffect
			delay(PREVIEW_DEBOUNCE_MS)
			val at = (slot as? RuleSlot.At)?.index
			preview = ops.preview(gatewayId, watcher.id, asked, at)?.let(::previewText) ?: "Could not check recent events."
		}
	}

	/** A delete is not the draft, so a refused one is never read against it. */
	fun send(put: RulesPut?, deleting: Boolean = false) {
		val sending = put ?: return
		busy = true
		scope.launch {
			val answer = ops.putRules(gatewayId, watcher.id, sending)
			busy = false
			if (answer is AssistantAnswer.State) return@launch onDone()
			val current = ops.watcher(gatewayId, watcher.id)?.let(::rulesOf)
			val next = if (answer is AssistantAnswer.Refused && !deleting && current != null) {
				afterRefusal(opened, current, slot, draft)
			} else {
				AfterRefusal.Stuck
			}
			when (next) {
				AfterRefusal.Landed -> onDone()
				is AfterRefusal.Over -> {
					opened = next.rules
					said = "The rules changed. Save again to apply over them."
				}
				AfterRefusal.Stuck ->
					said = if (deleting && answer is AssistantAnswer.Refused) "The rules changed. Reopen to delete." else answerText(answer)
			}
		}
	}

	ModalBottomSheet(onDismissRequest = onDismiss) {
		Column(
			Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(8.dp),
		) {
			Text(
				when (slot) {
					is RuleSlot.At -> "Rule ${slot.index + 1}"
					RuleSlot.New -> "New rule"
					RuleSlot.Otherwise -> "Anything else"
				},
				style = MaterialTheme.typography.titleLarge,
			)

			if (slot != RuleSlot.Otherwise) {
				Text("When", style = MaterialTheme.typography.labelLarge)
				draft.conditions.forEachIndexed { index, condition ->
					if (index > 0) {
						Text("and", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
						Box(Modifier.weight(1f)) {
							PickMenu(
								label = "Field",
								choices = opened.fields,
								picked = condition.field,
								labelOf = ::fieldLabel,
								onPick = { field -> draft = draft.changed(index) { it.copy(field = field) } },
							)
						}
						Box(Modifier.weight(0.7f)) {
							PickMenu(
								label = "Test",
								choices = RULE_TESTS,
								picked = condition.test,
								labelOf = ::testLabel,
								onPick = { test -> draft = draft.changed(index) { it.copy(test = test) } },
							)
						}
						if (draft.conditions.size > 1) {
							IconButton(onClick = hapticClick { draft = draft.withoutCondition(index) }) {
								Icon(Icons.Default.Close, contentDescription = "Remove condition")
							}
						}
					}
					OutlinedTextField(
						value = condition.value,
						onValueChange = { value -> draft = draft.changed(index) { it.copy(value = value) } },
						label = { Text("Value") },
						singleLine = true,
						modifier = Modifier.fillMaxWidth(),
					)
				}
				if (draft.conditions.size < MAX_CONDITIONS) {
					TextButton(onClick = hapticClick { draft = draft.withCondition(opened.fields) }) { Text("+ Add condition") }
				}
			}

			Text("Then", style = MaterialTheme.typography.labelLarge)
			SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
				RULE_ACTIONS.forEachIndexed { index, action ->
					SegmentedButton(
						selected = draft.action == action,
						onClick = hapticClick { draft = draft.copy(action = action) },
						shape = SegmentedButtonDefaults.itemShape(index = index, count = RULE_ACTIONS.size),
					) { Text(actionLabel(action)) }
				}
			}
			if (showsPing(draft.action)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Column(Modifier.weight(1f)) {
						Text("Ping my phone", style = MaterialTheme.typography.bodyLarge)
						Text(
							"Default: ${if (opened.pingDefault) "on" else "off"}",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
					Switch(
						checked = draft.pings(opened.pingDefault),
						onCheckedChange = { on -> draft = draft.copy(ping = pingAfter(on, opened.pingDefault)) },
					)
				}
			}

			preview?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			if (slot != RuleSlot.Otherwise) {
				Text(
					"Saving rechecks dropped events.",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

			HorizontalDivider()
			Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
				if (slot is RuleSlot.At) {
					TextButton(onClick = hapticClick { send(deleted(opened.held, slot.index), deleting = true) }, enabled = !busy) {
					Text("Delete")
				}
				}
				TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") }
				val put = saved(opened.held, slot, draft)
				Button(onClick = hapticClick { send(put) }, enabled = !busy && put != null) { Text("Save") }
			}
		}
	}
}
