package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.REACHES_HEADER
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.typeWordText
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType

@Composable
internal fun CallFields(
	step: StepDraft.Call,
	draft: AutomationDraft,
	offer: AutomationOffer,
	fields: SourceFields,
	tree: String?,
	enabled: Boolean,
	said: AutomationSaid?,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	reload: (String) -> Unit,
	flagged: Set<String>,
) {
	val key = step.key
	val choices = callChoices(draft, offer, tree)
	var naming by remember(key) { mutableStateOf(false) }
	val known = choices.filterIsInstance<CallChoice.Existing>()
	val picked = known.firstOrNull { it.id == step.function }
		?: draft.callees[step.function]?.let { CallChoice.Existing(it.id, it.name) }
	PickMenu(
		label = "Function",
		choices = choices,
		picked = picked,
		labelOf = { choice ->
			when (choice) {
				is CallChoice.Existing -> choice.name
				CallChoice.New -> "New function"
			}
		},
		onPick = { choice ->
			when (choice) {
				is CallChoice.Existing -> if (choice.id != step.function) {
					edit { it.withStep(key) { held -> (held as? StepDraft.Call)?.copy(function = choice.id, values = emptyMap()) ?: held } }
				}
				CallChoice.New -> naming = true
			}
		},
		enabled = enabled,
	)
	val params = step.function.takeIf { it.isNotBlank() }?.let { calleeParams(draft, offer, it) }
	if (step.function.isNotBlank() && params == null) {
		Text("That function is not listed.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	}
	val names = callNames(draft, offer, tree, key)
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	for (row in step.function.takeIf { it.isNotBlank() }?.let { callRows(draft, offer, fields, it) }.orEmpty()) {
		val param = row.param ?: continue
		when (val source = row.source) {
			ValueSource.FromTrigger -> Text("${param.name} from the trigger", style = MaterialTheme.typography.bodySmall, color = dim)
			is ValueSource.Mismatch -> Text(
				"${param.name}: trigger gives ${typeWordText(TypeWord.Given(source.gets)).lowercase()}; needs ${source.wants}.",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.error,
			)
			is ValueSource.Set, ValueSource.Unset -> CallValueRow(param, step.values[param.name], names, offer, enabled) { next ->
				edit { it.withStep(key) { held -> (held as? StepDraft.Call)?.let { call -> call.copy(values = withCallValue(call.values, param.name, next)) } ?: held } }
			}
		}
		IssueLine(refusedField(said, SaidAt.Card(key, param.name), saidText(draft, SaidAt.Card(key, param.name))))
	}
	for (name in strayCallValues(step, params)) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Text("$name is not one of its values", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
			IconButton(onClick = hapticClick { edit { it.withStep(key) { held -> (held as? StepDraft.Call)?.let { call -> call.copy(values = call.values - name) } ?: held } } }, enabled = enabled) {
				Icon(Icons.Default.Close, contentDescription = "Clear")
			}
		}
	}
	when (val line = callLine(draft, offer, said, step.function, flagged)) {
		is CallLine.Moved -> MovedLine(enabled) { reload(line.id) }
		CallLine.Attention -> Text("A step in it needs attention.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		null -> Unit
	}
	if (params != null) {
		TextButton(onClick = hapticClick { edit { it.openedCallee(step.function, offer) } }, enabled = enabled) { Text("Open its steps") }
	}
	if (naming) {
		NewFunctionDialog(onDismiss = { naming = false }) { name ->
			naming = false
			edit { it.withNewCallee(key, name) }
		}
	}
}

@Composable
private fun MovedLine(enabled: Boolean, onReload: () -> Unit) {
	Column {
		Text("It changed elsewhere. Reload to see it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		TextButton(onClick = hapticClick(onReload), enabled = enabled) { Text("Reload") }
	}
}

/** Blank typing clears it. */
internal fun withCallValue(values: Map<String, CallValue>, name: String, value: CallValue?): Map<String, CallValue> =
	if (value == null || (value is CallValue.Typed && value.text.isBlank())) values - name else values + (name to value)

/** Typed value; caller expression. */
@Composable
private fun CallValueRow(
	param: FunctionParam,
	value: CallValue?,
	names: List<String>,
	offer: AutomationOffer,
	enabled: Boolean,
	onChange: (CallValue?) -> Unit,
) {
	Row(verticalAlignment = Alignment.CenterVertically) {
		Box(Modifier.weight(1f)) {
			when {
				value is CallValue.Read -> Text(
					"${param.name} = ${value.expression}",
					fontFamily = FontFamily.Monospace,
					style = MaterialTheme.typography.bodyMedium,
				)
				param.type == FunctionParamType.DEVICE.wire -> PickMenu(
					label = param.name,
					choices = offer.switches,
					picked = offer.switches.find { it.device == (value as? CallValue.Typed)?.text },
					labelOf = { it.name },
					onPick = { onChange(CallValue.Typed(it.device)) },
					enabled = enabled,
				)
				else -> OutlinedTextField(
					value = (value as? CallValue.Typed)?.text.orEmpty(),
					onValueChange = { typed -> onChange(CallValue.Typed(typed)) },
					label = { Text(param.name) },
					singleLine = true,
					keyboardOptions = if (param.type == FunctionParamType.NUMBER.wire) NUMBER_KEYS else EXACT_KEYBOARD,
					enabled = enabled,
					modifier = Modifier.fillMaxWidth(),
				)
			}
		}
		if (value is CallValue.Read) {
			IconButton(onClick = hapticClick { onChange(null) }, enabled = enabled) { Icon(Icons.Default.Close, contentDescription = "Clear") }
		} else {
			NameMenu(names, enabled) { onChange(CallValue.Read(it)) }
		}
	}
}

@Composable
private fun NameMenu(names: List<String>, enabled: Boolean, onPick: (String) -> Unit) {
	if (names.isEmpty()) return
	var open by remember { mutableStateOf(false) }
	Box {
		TextButton(onClick = hapticClick { open = true }, enabled = enabled) { Text("Name") }
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			for (name in names) {
				DropdownMenuItem(
					text = { Text(name, fontFamily = FontFamily.Monospace) },
					onClick = hapticClick {
						open = false
						onPick(name)
					},
				)
			}
		}
	}
}

@Composable
private fun NewFunctionDialog(onDismiss: () -> Unit, onMade: (String) -> Unit) {
	var name by remember { mutableStateOf("") }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("New function") },
		text = {
			OutlinedTextField(value = name, onValueChange = { name = it.take(Protocol.Wire.FUNCTION_NAME_MAX) }, label = { Text("Name") }, singleLine = true)
		},
		confirmButton = { TextButton(onClick = { onMade(name) }, enabled = name.isNotBlank()) { Text("Make") } },
		dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
	)
}

/** Callee edits join saves. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CalleePage(
	callee: CalleeDraft,
	draft: AutomationDraft,
	offer: AutomationOffer,
	fields: SourceFields,
	enabled: Boolean,
	said: AutomationSaid?,
	textRead: @Composable (String?) -> PreviewRead,
	conditionRead: @Composable (String) -> PreviewRead,
	asked: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
	reload: (String) -> Unit,
	rows: List<AutomationRow>,
	kept: KeptScript,
	issues: DrawnIssues?,
	/** Its script, read-only. */
	script: @Composable () -> Unit,
) {
	val others = alsoRunBy(draft, offer, rows, callee.id)
	Scaffold(
		topBar = {
			TopAppBar(
				title = { FunctionName(callee.name, null) },
				navigationIcon = {
					IconButton(onClick = hapticClick { edit { it.copy(inside = it.inside.dropLast(1)) } }, enabled = enabled) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { padding ->
		Column(
			Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			if (movedCallee(said, draft, offer) == callee.id) MovedLine(enabled) { reload(callee.id) }
			droppedLine(droppedEdits(draft, offer).filter { it.id == callee.id })?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			}
			if (others.isNotEmpty()) {
				Text(REACHES_HEADER, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				for (sentence in others) Text(sentence, style = MaterialTheme.typography.bodyMedium)
			}
			ScriptSwitch(draft, callee.id, offer, enabled, edit)
			if (showsScript(draft, callee.id, offer)) script()
			else CardsSection(
				draft = draft,
				offer = offer,
				fields = fields,
				enabled = enabled,
				said = said,
				textRead = textRead,
				conditionRead = conditionRead,
				asked = asked,
				lastRun = null,
				edit = edit,
				reload = reload,
				tree = callee.id,
				kept = kept.lines,
				onScriptAt = kept.open,
				issues = issues,
			)
		}
	}
}
