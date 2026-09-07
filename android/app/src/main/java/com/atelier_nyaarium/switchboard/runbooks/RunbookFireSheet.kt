package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val PREVIEW_SETTLE_MS = 400L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunbookFireSheet(repo: ChatRepository, state: ChatState, runbookId: String, onDismiss: () -> Unit) {
	val runbook = remember(runbookId, state.runbooks) { state.runbooks.find { it.id == runbookId } }
	if (runbook == null) {
		LaunchedEffect(runbookId) { onDismiss() }
		return
	}
	val gatewayId = state.homeGatewayId
	val sheet = remember(runbookId) { FireSheetState(runbook, gatewayId) }
	LaunchedEffect(runbook.revision) { sheet.adopt(runbook) }
	val values = sheet.values
	val scope = rememberCoroutineScope()

	LaunchedEffect(runbook.revision, sheet.gateway, values) {
		sheet.preview = (sheet.preview as? PreviewState.Ready)?.let { PreviewState.Stale(it.text) }
			?: PreviewState.Pending
		delay(PREVIEW_SETTLE_MS)
		val answer = repo.runbookOps.preview(runbookId, values, sheet.gateway)
		sheet.preview = when {
			answer == null -> PreviewState.Unreachable(repo.runbookOps.conflictOf(runbookId)?.reason)
			answer.text != null -> PreviewState.Ready(answer.text, answer.revision)
			else -> PreviewState.Refused(answer.reason ?: "these values do not render")
		}
	}

	ModalBottomSheet(onDismissRequest = onDismiss) {
		Column(
			Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text(runbook.name, style = MaterialTheme.typography.titleLarge)

			Column(
				Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
				verticalArrangement = Arrangement.spacedBy(12.dp),
			) {
				for (parameter in runbook.parameters) {
					val value = values[parameter.name] ?: ""
					if (parameter.kind == "choice") {
						Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
							Text(parameter.label, style = MaterialTheme.typography.labelLarge)
							FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
								for (option in parameter.options.orEmpty()) {
									FilterChip(
										selected = value == option,
										onClick = hapticClick { sheet.values = values + (parameter.name to option) },
										label = { Text(chipLabel(option), maxLines = 1, overflow = TextOverflow.Ellipsis) },
									)
								}
							}
						}
					} else {
						OutlinedTextField(
							value = value,
							onValueChange = { sheet.values = values + (parameter.name to it) },
							label = { Text(parameter.label) },
							singleLine = true,
							modifier = Modifier.fillMaxWidth(),
						)
					}
				}

				Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
					SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
						SegmentedButton(
							selected = sheet.freshSession,
							onClick = hapticClick { sheet.aimAt(true) },
							shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
						) { Text("New session") }
						SegmentedButton(
							selected = !sheet.freshSession,
							onClick = hapticClick { sheet.aimAt(false) },
							shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
						) { Text("Existing session") }
					}
					val gateways = gatewayTargets(state)
					if (gateways.size > 1) {
						TargetMenu(
							label = "Gateway",
							choices = gateways.map { FireTarget(it, it) },
							picked = FireTarget(sheet.gateway, sheet.gateway),
							onPick = { sheet.aimAtGateway(it.address) },
						)
					}
					val choices =
						if (sheet.freshSession) spawnTargets(state, sheet.gateway)
						else sessionTargets(state, sheet.gateway)
					TargetMenu(
						label = if (sheet.freshSession) "Start on" else "Send to",
						choices = choices,
						picked = choices.find { it.address == sheet.target },
						onPick = { sheet.pick(it.address) },
					)
				}

				PreviewPane(sheet.preview)
				sheet.refusal?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
			}

			Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
				TextButton(onClick = hapticClick(onDismiss), modifier = Modifier.weight(1f)) { Text("Cancel") }
				val ready = (sheet.preview as? PreviewState.Ready)?.takeIf { it.revision == runbook.revision }
				Button(
					enabled = ready != null && !sheet.firing && sheet.target.isNotBlank(),
					onClick = hapticClick {
						val pinned = ready ?: return@hapticClick
						sheet.firing = true
						sheet.refusal = null
						scope.launch {
							val into = if (sheet.freshSession) {
								RunbookFireTarget.New(target = sheet.target, displayLabel = runbook.name)
							} else {
								RunbookFireTarget.Session(target = sheet.target)
							}
							val answer = repo.runbookOps.fire(runbookId, values, into, pinned.revision, sheet.gateway)
							sheet.firing = false
							if (answer?.fired == true) {
								onDismiss()
							} else {
								sheet.refusal = answer?.reason
									?: repo.runbookOps.conflictOf(runbookId)?.reason
									?: "the fire did not reach this Gateway"
							}
						}
					},
					modifier = Modifier.weight(1f),
				) { Text(if (sheet.firing) "Firing" else "Fire") }
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TargetMenu(label: String, choices: List<FireTarget>, picked: FireTarget?, onPick: (FireTarget) -> Unit) {
	var open by remember { mutableStateOf(false) }

	ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = Modifier.fillMaxWidth()) {
		OutlinedTextField(
			value = picked?.label ?: "",
			onValueChange = {},
			readOnly = true,
			label = { Text(label) },
			placeholder = { Text(if (choices.isEmpty()) "Nothing to pick" else "Choose one") },
			trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
			modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
		)
		ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			for (choice in choices) {
				DropdownMenuItem(
					text = { Text(choice.label) },
					onClick = hapticClick {
						onPick(choice)
						open = false
					},
				)
			}
		}
	}
}

@Composable
private fun PreviewPane(preview: PreviewState) {
	val rendered = when (preview) {
		is PreviewState.Ready -> preview.text
		is PreviewState.Stale -> preview.text
		else -> null
	}
	Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
		Text(
			if (preview is PreviewState.Stale) "Preview, rendering" else "Preview",
			style = MaterialTheme.typography.labelLarge,
		)
		Surface(tonalElevation = 2.dp) {
			Column(Modifier.fillMaxWidth().padding(10.dp)) {
				when {
					rendered != null -> Text(
						rendered,
						style = MaterialTheme.typography.bodySmall,
						fontFamily = FontFamily.Monospace,
						modifier = Modifier.horizontalScroll(rememberScrollState()),
					)
					preview is PreviewState.Refused -> Text(preview.reason, style = MaterialTheme.typography.bodySmall)
					preview is PreviewState.Unreachable -> Text(
						preview.reason ?: "This Gateway did not answer",
						style = MaterialTheme.typography.bodySmall,
					)
					else -> Text("Rendering", style = MaterialTheme.typography.bodySmall)
				}
			}
		}
	}
}

internal class FireSheetState(runbook: Runbook, gatewayId: String) {
	var revision by mutableStateOf(runbook.revision)
		private set

	var values by mutableStateOf(runbook.parameters.associate { it.name to (it.default ?: "") })
	var preview by mutableStateOf<PreviewState>(PreviewState.Pending)
	var refusal by mutableStateOf<String?>(null)

	var freshSession by mutableStateOf(true)
		private set
	var gateway by mutableStateOf(gatewayId)
		private set
	var target by mutableStateOf("")
		private set

	fun aimAt(fresh: Boolean) {
		if (fresh == freshSession) return
		freshSession = fresh
		target = ""
	}

	fun aimAtGateway(id: String) {
		if (id == gateway) return
		gateway = id
		target = ""
	}

	fun pick(address: String) {
		target = address
	}
	var firing by mutableStateOf(false)

	fun adopt(runbook: Runbook) {
		if (runbook.revision == revision) return
		revision = runbook.revision
		values = runbook.parameters.associate { it.name to (it.default ?: "") }
		preview = PreviewState.Pending
		refusal = null
	}
}

internal sealed interface PreviewState {
	data object Pending : PreviewState
	data class Unreachable(val reason: String?) : PreviewState
	data class Stale(val text: String) : PreviewState
	data class Ready(val text: String, val revision: Long) : PreviewState
	data class Refused(val reason: String) : PreviewState
}
