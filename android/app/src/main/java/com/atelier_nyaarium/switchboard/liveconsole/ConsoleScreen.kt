package com.atelier_nyaarium.switchboard.liveconsole

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.CodePalette
import com.atelier_nyaarium.switchboard.ConsoleEntry
import com.atelier_nyaarium.switchboard.LiveConsoleView
import com.atelier_nyaarium.switchboard.ViewScope
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import com.atelier_nyaarium.switchboard.AssistantHome

internal val CODE = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Color(CodePalette.TEXT))

private class Names(val entities: Set<String>, val variables: Set<String>)

private fun painted(source: String, names: Names, issue: IntRange? = null): AnnotatedString =
	paintedCode(source, consolePaint(source, names.entities, names.variables), issue)

/** `issue` is underlined. */
internal fun paintedCode(source: String, spans: List<PaintSpan>, issue: IntRange? = null): AnnotatedString =
	buildAnnotatedString {
		append(source)
		for (span in spans) {
			val style = CodePalette.styleOf(span.token)
			addStyle(
				SpanStyle(
					color = Color(style.argb),
					fontWeight = if (style.bold) FontWeight.Bold else null,
					fontStyle = if (style.italic) FontStyle.Italic else null,
					background = style.background?.let { Color(it) } ?: Color.Unspecified,
				),
				span.start,
				span.end,
			)
		}
		if (issue != null && !issue.isEmpty()) {
			addStyle(
				SpanStyle(textDecoration = TextDecoration.Underline, color = Color(0xFFFFA198)),
				issue.first.coerceIn(0, source.length),
				(issue.last + 1).coerceIn(0, source.length),
			)
		}
	}

private class ConsoleHighlight(private val names: Names) : VisualTransformation {
	override fun filter(text: AnnotatedString) = TransformedText(painted(text.text, names), OffsetMapping.Identity)
}

/** Code is typed as written. */
private val CODE_KEYBOARD =
	KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password)

@Composable
internal fun ConsoleScreen(
	repo: ChatRepository,
	state: ChatState,
	modifier: Modifier = Modifier,
	scope: ViewScope = ViewScope.Everything,
) {
	var picked by rememberSaveable { mutableStateOf<String?>(null) }
	val home = (state.assistantHome as? AssistantHome.Read)?.record?.gatewayId
	val gatewayId = consoleGatewayOf(scope, state.gateways, picked, home)
	val views by repo.liveConsoleOps.state.collectAsState()
	if (gatewayId == null) {
		Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
			Text(noGatewayLine(state.gateways), color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		return
	}
	val view = views[gatewayId] ?: LiveConsoleView()
	LaunchedEffect(gatewayId) { repo.command { liveConsoleOps.open(gatewayId) } }
	var field by remember(gatewayId) { mutableStateOf(TextFieldValue(view.draft, TextRange(view.draft.length))) }
	val names =
		remember(view.description, view.variables.keys) {
			Names(view.description?.entities?.map { it.name }?.toSet().orEmpty(), view.variables.keys)
		}
	val assist =
		remember(field.text, field.selection, view.description, view.ids, view.variables) {
			consoleAssist(field.text, field.selection.start, view.description, view.ids, variableShapes(view.variables))
		}
	val list = remember(gatewayId) { LazyListState() }
	// IDs detect new entries.
	LaunchedEffect(gatewayId, view.entries.lastOrNull()?.id) {
		if (view.entries.isNotEmpty()) list.animateScrollToItem(view.entries.lastIndex)
	}
	val now = System.currentTimeMillis()

	fun edit(next: TextFieldValue) {
		field = next
		repo.liveConsoleOps.setDraft(gatewayId, next.text)
	}

	val focus = remember { FocusRequester() }

	fun insert(text: String) {
		edit(TextFieldValue(text, TextRange(text.length)))
		focus.requestFocus()
	}

	Column(modifier.fillMaxSize().imePadding()) {
		if (picksGateway(scope, state.gateways)) {
			GatewayPicker(gatewayId, consoleGateways(state.gateways, gatewayId)) { picked = it }
		}
		if (view.variables.isNotEmpty()) {
			VariableStrip(view.variables, onPick = ::insert, onDrop = { repo.liveConsoleOps.dropVariable(gatewayId, it) })
		}
		LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
			if (view.entries.isEmpty()) {
				item {
					Intro(view, names) { name -> insert(name) }
				}
			}
			items(view.entries, key = { it.id }) { entry ->
				EntryBlock(entry, view.description, names, now, onRecall = { insert(entry.expr) }, onInsert = ::insert)
			}
		}
		Dock(
			field = field,
			assist = assist,
			names = names,
			recall = repo.liveConsoleOps.recall(gatewayId),
			focus = focus,
			onField = ::edit,
			onSend = {
				val expr = field.text
				if (canRun(expr)) {
					edit(TextFieldValue(""))
					repo.command { liveConsoleOps.run(gatewayId, expr) }
				}
			},
		)
	}
}

@Composable
private fun GatewayPicker(chosen: String, ids: List<String>, onPick: (String) -> Unit) {
	var open by remember { mutableStateOf(false) }
	Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
		Spacer(Modifier.weight(1f))
		Box {
			OutlinedButton(onClick = hapticClick { open = true }) {
				Text(chosen)
				Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
			}
			DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
				for (id in ids) {
					DropdownMenuItem(text = { Text(id) }, onClick = {
						open = false
						onPick(id)
					})
				}
			}
		}
	}
}

@Composable
private fun VariableStrip(variables: Map<String, ConsoleVariable>, onPick: (String) -> Unit, onDrop: (String) -> Unit) {
	Row(
		Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text("Variables", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		for ((name, variable) in variables) {
			InputChip(
				selected = false,
				onClick = hapticClick { onPick(name) },
				label = { Text("$name  ${variableLabel(variable)}", fontFamily = FontFamily.Monospace) },
				trailingIcon = {
					Icon(
						Icons.Filled.Close,
						contentDescription = "Forget $name",
						modifier = Modifier.size(16.dp).clickable { onDrop(name) },
					)
				},
			)
		}
	}
}

@Composable
private fun Intro(view: LiveConsoleView, names: Names, onPick: (String) -> Unit) {
	Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		val description = view.description
		when {
			description != null -> {
				Text("Read-only. Tap an entity to start.", color = MaterialTheme.colorScheme.onSurfaceVariant)
				for (entity in description.entities) {
					Row(Modifier.fillMaxWidth().clickable { onPick(entity.name) }.padding(vertical = 4.dp)) {
						Text(painted(entity.name, names), style = CODE, modifier = Modifier.padding(end = 12.dp))
						Text(entity.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
				}
			}
			else -> Text(vocabularyLine(view.vocabulary), color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

@Composable
private fun EntryBlock(
	entry: ConsoleEntry,
	description: ConsoleDescription?,
	names: Names,
	now: Long,
	onRecall: () -> Unit,
	onInsert: (String) -> Unit,
) {
	Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
		Row(Modifier.fillMaxWidth().clickable(onClick = onRecall).padding(vertical = 4.dp)) {
			Text("> ", style = CODE.copy(color = Color(CodePalette.LINE_NUMBER)))
			Text(painted(entry.expr, names), style = CODE)
		}
		when (val shown = entryDrawn(entry.state, description, now)) {
			EntryDrawn.Running -> CircularProgressIndicator(Modifier.size(20.dp).padding(2.dp), strokeWidth = 2.dp)
			is EntryDrawn.Said -> Text(shown.line, color = MaterialTheme.colorScheme.error)
			is EntryDrawn.Cards ->
				Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
					for (drawn in shown.cards) {
						drawn.saved?.let {
							Text(
								"saved as $it",
								style = MaterialTheme.typography.labelSmall,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
						when (val card = drawn.card) {
							is ConsoleCard.Failed -> FailedCard(entry.expr, card, names)
							is ConsoleCard.Schema -> SchemaCard(card.entity, names, onInsert)
							is ConsoleCard.Sensor -> SensorCard(card)
							is ConsoleCard.Rows -> RowsCard(card)
							is ConsoleCard.Fields -> FieldsCard(card)
							is ConsoleCard.Scalar ->
								ResultSurface { Text(card.text, style = CODE, modifier = Modifier.padding(14.dp)) }
						}
					}
				}
		}
	}
}

@Composable
private fun ResultSurface(content: @Composable () -> Unit) {
	Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
		Column { content() }
	}
}

@Composable
private fun FailedCard(source: String, card: ConsoleCard.Failed, names: Names) {
	Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Text(failedLine(card.issue), color = MaterialTheme.colorScheme.onErrorContainer)
			val range = card.issue.start.toInt() until card.issue.end.toInt()
			Text(painted(source, names, range), style = CODE)
		}
	}
}

@Composable
private fun SchemaCard(entity: ConsoleEntityDescription, names: Names, onInsert: (String) -> Unit) {
	ResultSurface {
		Text(entity.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, top = 14.dp, end = 16.dp))
		Text(
			entity.description,
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
		)
		for (member in entity.members) {
			Column(
				Modifier.fillMaxWidth()
					.clickable { onInsert(memberInsert(entity, member)) }
					.padding(horizontal = 16.dp, vertical = 8.dp),
			) {
				Text(painted(memberSignature(member), names), style = CODE)
				if (member.description.isNotEmpty()) {
					Text(member.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
		Spacer(Modifier.height(6.dp))
	}
}

@Composable
private fun SensorCard(card: ConsoleCard.Sensor) {
	ResultSurface {
		Text(card.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, top = 14.dp, end = 16.dp))
		Text(
			card.line,
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
		)
		for (reading in card.readings) {
			Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(reading.label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
					Text(reading.shown, style = MaterialTheme.typography.headlineSmall)
				}
				reading.range?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
		Spacer(Modifier.height(8.dp))
	}
}

@Composable
private fun RowsCard(card: ConsoleCard.Rows) {
	ResultSurface {
		Text(
			card.heading,
			style = MaterialTheme.typography.labelMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.padding(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
		)
		for (row in card.rows) {
			Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					Text(row.title, Modifier.weight(1f))
					row.tag?.let {
						Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
							Text(it, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
						}
					}
					row.trailing?.let {
						Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
				}
				row.detail?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
		moreLine(card)?.let {
			Text(
				it,
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.primary,
				modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
			)
		}
		Spacer(Modifier.height(4.dp))
	}
}

@Composable
private fun FieldsCard(card: ConsoleCard.Fields) {
	ResultSurface {
		Column(Modifier.padding(vertical = 10.dp)) {
			for (line in card.lines) {
				Row(Modifier.padding(start = (16 + line.depth * 14).dp, end = 16.dp, top = 2.dp, bottom = 2.dp)) {
					Text(
						if (line.text == null) "${line.key}:" else "${line.key}: ",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					line.text?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
				}
			}
		}
	}
}

/** Hint, then completions. */
@Composable
internal fun AssistRows(assist: ConsoleAssist, onApply: (ConsoleCompletion) -> Unit) {
	assist.hint?.let { hint ->
		Surface(
			shape = RoundedCornerShape(12.dp),
			color = MaterialTheme.colorScheme.surfaceContainerHigh,
			modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
		) {
			Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
				Text(
					buildAnnotatedString {
						append("${hint.name}(")
						hint.params.forEachIndexed { at, param ->
							if (at > 0) append(", ")
							if (at == hint.active) {
								pushStyle(SpanStyle(fontWeight = FontWeight.Bold, textDecoration = TextDecoration.Underline))
								append(param)
								pop()
							} else {
								append(param)
							}
						}
						append(") -> ${hint.returns}")
					},
					style = CODE.copy(color = MaterialTheme.colorScheme.onSurface),
				)
				hint.note?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
	}
	if (assist.completions.isNotEmpty()) {
		Row(
			Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
			horizontalArrangement = Arrangement.spacedBy(8.dp),
		) {
			for (completion in assist.completions) {
				AssistChip(
					onClick = hapticClick { onApply(completion) },
					label = { Text(completion.label, fontFamily = FontFamily.Monospace) },
				)
			}
		}
	}
}

@Composable
private fun Dock(
	field: TextFieldValue,
	assist: ConsoleAssist,
	names: Names,
	recall: List<String>,
	focus: FocusRequester,
	onField: (TextFieldValue) -> Unit,
	onSend: () -> Unit,
) {
	Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(top = 6.dp)) {
		AssistRows(assist) { completion ->
			val (text, cursor) = completion.applyTo(field.text)
			onField(TextFieldValue(text, TextRange(cursor)))
		}
		Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
			var history by remember { mutableStateOf(false) }
			Box {
				IconButton(onClick = hapticClick { history = true }, enabled = recall.isNotEmpty()) {
					Icon(Icons.Filled.History, contentDescription = "History")
				}
				DropdownMenu(expanded = history, onDismissRequest = { history = false }) {
					for (expr in recall) {
						DropdownMenuItem(text = { Text(painted(expr, names), style = CODE, maxLines = 2) }, onClick = {
							history = false
							onField(TextFieldValue(expr, TextRange(expr.length)))
						})
					}
				}
			}
			BasicTextField(
				value = field,
				onValueChange = onField,
				textStyle = CODE,
				cursorBrush = SolidColor(Color(CodePalette.TEXT)),
				visualTransformation = remember(names) { ConsoleHighlight(names) },
				keyboardOptions = CODE_KEYBOARD,
				modifier =
					Modifier.weight(1f)
						.focusRequester(focus)
						.heightIn(min = 48.dp)
						.background(Color(CodePalette.BACKGROUND), RoundedCornerShape(12.dp))
						.border(1.dp, Color(CodePalette.BORDER), RoundedCornerShape(12.dp))
						.padding(horizontal = 14.dp, vertical = 14.dp),
			)
			Spacer(Modifier.size(8.dp))
			FilledIconButton(onClick = hapticClick(onSend), enabled = canRun(field.text)) {
				Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Run")
			}
		}
	}
}
