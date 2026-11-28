package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.AutomationOps
import com.atelier_nyaarium.switchboard.CodePalette
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.liveconsole.CODE
import com.atelier_nyaarium.switchboard.liveconsole.consoleScriptPaint
import com.atelier_nyaarium.switchboard.liveconsole.paintedCode
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptPrintResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.delay

private const val PARSE_DEBOUNCE_MS = 400L

private val LINE_STYLE = CODE.copy(fontSize = 13.sp, lineHeight = 19.sp)

internal data class PrintRead(val answer: ConsoleScriptPrintResult? = null, val failed: Boolean = false)

/** Exact settled request print. */
@Composable
internal fun scriptPrintRead(ops: AutomationOps, gatewayId: String, op: ConsoleOp.ScriptPrint?, settle: Long = 0L): PrintRead {
	var read by remember(gatewayId) { mutableStateOf(PrintRead()) }
	LaunchedEffect(gatewayId, op) {
		read = PrintRead()
		val asked = op ?: return@LaunchedEffect
		delay(settle)
		val answer = ops.scriptPrint(gatewayId, asked)
		read = PrintRead(answer, failed = answer == null)
	}
	return read
}

/** Parse after typing settles. */
@Composable
internal fun ScriptParses(
	ops: AutomationOps,
	gatewayId: String,
	draft: AutomationDraft,
	offer: AutomationOffer,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	for (tree in draft.scriptTrees()) {
		key(tree) {
			val send = parseToSend(draft, tree, offer)
			LaunchedEffect(gatewayId, send) {
				val asked = send ?: return@LaunchedEffect
				delay(PARSE_DEBOUNCE_MS)
				val answer = ops.scriptParse(gatewayId, asked)
				edit { if (answer == null) it.parseFailed(tree, asked, offer) else it.parsedInto(tree, asked, answer, offer) }
			}
		}
	}
}

/** Require current parse. */
@Composable
internal fun ScriptSwitch(
	draft: AutomationDraft,
	tree: String?,
	offer: AutomationOffer,
	enabled: Boolean,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	if (!scriptServed(offer)) return
	val script = draft.scriptedOf(tree)
	val cards = cardsAllowed(draft, tree, offer)
	SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
		SegmentedButton(
			selected = !script,
			onClick = hapticClick { edit { it.shownAs(tree, script = false, offer) } },
			shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
			enabled = enabled && cards,
			icon = {},
		) { Text("Cards") }
		SegmentedButton(
			selected = script,
			onClick = hapticClick { edit { it.shownAs(tree, script = true, offer) } },
			shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
			enabled = enabled,
			icon = {},
		) { Text("Script") }
	}
}

@Composable
internal fun ScriptSection(
	ops: AutomationOps,
	gatewayId: String,
	draft: AutomationDraft,
	tree: String?,
	offer: AutomationOffer,
	enabled: Boolean,
	lastRun: AutomationLastRun?,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	val error = MaterialTheme.colorScheme.error
	val print = scriptPrintRead(ops, gatewayId, scriptPrintOp(draft, tree, offer))
	val words by ops.scriptWords.collectAsState()
	LaunchedEffect(gatewayId) { ops.describeScript(gatewayId) }
	val entities = words[gatewayId]?.description?.entities.orEmpty().map { it.name }.toSet()
	val printed = print.answer
	fun open(at: Int?) = edit { it.startedScript(tree, (draft.scriptOf(tree)?.text ?: printed?.text).orEmpty(), printed?.names.orEmpty(), printed?.types.orEmpty(), at) }
	when (val shown = scriptShown(draft, tree, offer, printed, print.failed)) {
		ScriptShown.Reading -> Text("Reading", style = MaterialTheme.typography.bodySmall, color = dim)
		ScriptShown.Unread -> Text("The script could not be read now.", style = MaterialTheme.typography.bodySmall, color = dim)
		ScriptShown.Unwritable -> Text("Finish the cards first; the script is written from them.", style = MaterialTheme.typography.bodySmall, color = dim)
		is ScriptShown.Text -> {
			lastRun?.let { run ->
				Text(if (run.running) "Running now" else "Last run ${agoText(run.at)}", style = MaterialTheme.typography.labelMedium, color = dim)
			}
			val first = markedIssue(shown.issues)?.let { it.start.toInt() until maxOf(it.end.toInt(), it.start.toInt() + 1) }
			ScriptLines(shown.text, scriptLines(shown.text, shown.statements, lastRun, pointing = draft.runs is RunsHead.Points), entities, shown.names, first)
			for (issue in shown.issues) {
				IssueRow(shown.text, issue, enabled && shown.editable) { open(issue.start.toInt()) }
			}
			when {
				shown.errors -> Text("It has errors and will not run. Cards return when the script reads.", style = MaterialTheme.typography.bodySmall, color = error)
				shown.fixed -> Text("It reads now. Save to make it run.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
				shown.checking -> Text("Checking", style = MaterialTheme.typography.bodySmall, color = dim)
			}
			ParseTrouble(shown.failed, shown.tooLong, enabled) { edit { it.parseRetried(tree) } }
			shown.readOnly?.let { Text("Read only: $it", style = MaterialTheme.typography.bodySmall, color = dim) }
			Row(verticalAlignment = Alignment.CenterVertically) {
				if (shown.discard) {
					TextButton(onClick = hapticClick { edit { it.discardedScript(tree) } }, enabled = enabled) { Text("Discard script changes") }
				}
				Box(Modifier.weight(1f))
				TextButton(onClick = hapticClick { open(null) }, enabled = enabled && shown.editable) { Text("Edit") }
			}
		}
	}
}

@Composable
private fun ParseTrouble(failed: Boolean, tooLong: Boolean, enabled: Boolean, onRetry: () -> Unit) {
	val error = MaterialTheme.colorScheme.error
	if (tooLong) Text("Longer than ${Protocol.Wire.SCRIPT_SOURCE_MAX} characters; it cannot be checked or saved.", style = MaterialTheme.typography.bodySmall, color = error)
	if (failed) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Text("It could not be checked now.", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = error)
			TextButton(onClick = hapticClick(onRetry), enabled = enabled) { Text("Retry") }
		}
	}
}

@Composable
private fun IssueRow(text: String, issue: com.atelier_nyaarium.switchboard.proto.ScriptIssue, enabled: Boolean, onJump: () -> Unit) {
	Text(
		"Line ${lineOf(text, issue.start.toInt())}: ${issue.message}",
		style = MaterialTheme.typography.bodySmall,
		color = if (drawsAsError(issueLevelOf(issue.level))) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outline,
		modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = hapticClick(onJump)).padding(vertical = 2.dp),
	)
}

private fun lineOf(text: String, offset: Int): Int = text.take(offset.coerceIn(0, text.length)).count { it == '\n' } + 1

@Composable
private fun ScriptLines(text: String, lines: List<ScriptLine>, entities: Set<String>, names: Set<String>, issue: IntRange?) {
	val painted = remember(text, entities, names, issue) { paintedCode(text, consoleScriptPaint(text, entities, names), issue) }
	val shape = RoundedCornerShape(12.dp)
	SelectionContainer {
		Column(
			Modifier.fillMaxWidth()
				.background(Color(CodePalette.BACKGROUND), shape)
				.border(1.dp, Color(CodePalette.BORDER), shape)
				.padding(vertical = 8.dp),
		) {
			for (line in lines) {
				Row(verticalAlignment = Alignment.Top) {
					Box(Modifier.padding(start = 6.dp, end = 8.dp, top = 3.dp).width(3.dp).height(13.dp).background(markColor(line.mark), RoundedCornerShape(2.dp)))
					Column(Modifier.weight(1f).padding(end = 8.dp)) {
						Text(painted.subSequence(line.start, line.end.coerceAtMost(painted.length)), style = LINE_STYLE)
						line.said?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
					}
				}
			}
		}
	}
}

@Composable
private fun markColor(mark: LineMark?): Color = when (mark) {
	null -> Color.Transparent
	LineMark.UNREACHED -> Color(CodePalette.BORDER)
	LineMark.DONE -> MaterialTheme.colorScheme.onSurfaceVariant
	LineMark.UNSURE -> Color(CodePalette.MARK)
	LineMark.FAILED -> MaterialTheme.colorScheme.error
	LineMark.RUNNING -> MaterialTheme.colorScheme.primary
}

@Composable
internal fun ScriptEditorPage(
	ops: AutomationOps,
	gatewayId: String,
	draft: AutomationDraft,
	tree: String?,
	offer: AutomationOffer,
	enabled: Boolean,
	ids: com.atelier_nyaarium.switchboard.proto.ConsoleIds?,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
) {
	val typed = draft.scriptOf(tree) ?: return
	val words by ops.scriptWords.collectAsState()
	LaunchedEffect(gatewayId) { ops.describeScript(gatewayId) }
	val vocabulary = words[gatewayId]
	val current = scriptCurrent(draft, tree, offer)
	val issues = scriptIssues(draft, tree, offer)
	val signature = scriptSignature(draft, tree, offer)
	TextPageEditor(
		title = "Script",
		value = typed.text,
		max = Protocol.Wire.SCRIPT_SOURCE_MAX,
		names = scriptNamesHere(namesHere(offer, draft.trigger.kind, null, scriptParamsOf(draft, tree)), typed.names),
		mode = TextMode.SCRIPT,
		issueOf = { text -> markedIssue(issues)?.takeIf { text == typed.text }?.let { it.start.toInt().coerceAtMost(text.length) until maxOf(it.end.toInt(), it.start.toInt() + 1).coerceAtMost(text.length) } },
		description = vocabulary?.description,
		ids = ids,
		shapes = emptyMap(),
		shapesAt = { cursor -> scriptShapes(typed.names, typed.types, cursor) },
		enabled = enabled,
		onChange = { text -> edit { it.typedScript(tree, text) } },
		onBack = { edit { it.copy(scriptPage = null) } },
		above = { SignatureHead(signature) },
		start = draft.scriptPage?.at,
		startKey = draft.scriptPage?.jumps ?: 0,
	) { text ->
		val dim = MaterialTheme.colorScheme.onSurfaceVariant
		for (issue in issues.takeIf { text == typed.text }.orEmpty()) {
			IssueRow(text, issue, enabled) { edit { it.jumpedTo(issue.start.toInt()) } }
		}
		val failed = typed.failed != null && typed.failed == scriptParseOp(draft, tree, offer)
		val tooLong = text.length > Protocol.Wire.SCRIPT_SOURCE_MAX
		if (!current && !failed && !tooLong) Text("Checking", style = MaterialTheme.typography.bodySmall, color = dim)
		ParseTrouble(failed, tooLong, enabled) { edit { it.parseRetried(tree) } }
	}
}

@Composable
private fun SignatureHead(signature: ScriptSignature) {
	val shape = RoundedCornerShape(10.dp)
	Column(
		Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape).padding(horizontal = 12.dp, vertical = 8.dp),
		verticalArrangement = Arrangement.spacedBy(2.dp),
	) {
		Text("$FUNCTION_MARK ${signature.name ?: "(unnamed)"}(${signature.params.joinToString(", ")})", style = LINE_STYLE, color = MaterialTheme.colorScheme.onSurface)
		if (signature.given.isNotEmpty()) {
			Text("From the trigger: ${signature.given.joinToString(", ")}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

internal data class ScriptOnlyCards(val lines: Map<String, ScriptOnlyLine>, val open: ((Int) -> Unit)?)

@Composable
internal fun scriptOnlyCards(
	ops: AutomationOps,
	gatewayId: String,
	draft: AutomationDraft,
	tree: String?,
	offer: AutomationOffer,
	edit: ((AutomationDraft) -> AutomationDraft) -> Unit,
): ScriptOnlyCards {
	val asks = scriptServed(offer) && everyStep(draft.stepsOf(tree)).any { it is StepDraft.ScriptOnly }
	val print = scriptPrintRead(ops, gatewayId, scriptPrintOp(draft, tree, offer).takeIf { asks }, settle = PARSE_DEBOUNCE_MS).answer
	val open: ((Int) -> Unit)? = print?.takeIf { it.readOnly == null }?.let { printed ->
		{ at -> edit { it.startedScript(tree, printed.text, printed.names, printed.types, at) } }
	}
	return ScriptOnlyCards(scriptOnlyLines(draft.stepsOf(tree), print), open)
}
