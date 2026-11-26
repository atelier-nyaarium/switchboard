package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.CodeToken
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleAssist
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleCompletion
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleTokenKind
import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.PaintSpan
import com.atelier_nyaarium.switchboard.liveconsole.VariableShape
import com.atelier_nyaarium.switchboard.liveconsole.applyTo
import com.atelier_nyaarium.switchboard.liveconsole.consoleAssist
import com.atelier_nyaarium.switchboard.liveconsole.consolePaint
import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import com.atelier_nyaarium.switchboard.proto.FunctionStep

/** Text slot by its card's key and parameter. */
internal data class TextRef(val key: String, val param: String)

/** If condition parameter. */
internal const val WHEN = "when"

/** Wait minutes parameter. */
internal const val MINUTES = "minutes"

internal enum class TextMode { HOLES, EXPRESSION }

internal fun conditionAt(draft: AutomationDraft, ref: TextRef): String? =
	(draft.stepAt(ref.key) as? StepDraft.If)?.condition?.takeIf { ref.param == WHEN }

/** Kept names; catch failure. */
internal fun runNamesHere(steps: List<StepDraft>, key: String): List<NameHere> {
	val kept = everyStep(steps).mapNotNull { ((it as? StepDraft.Kept)?.step as? FunctionStep.Let)?.name }.distinct()
	val failure = if (insideCatch(steps, key)) listOf(NameHere("e", "What failed", null)) else emptyList()
	return kept.map { NameHere(it, "Kept while it runs", null) } + failure
}

private fun insideCatch(steps: List<StepDraft>, key: String): Boolean =
	everyStep(steps).filterIsInstance<StepDraft.Try>().any { held -> findStep(held.catch, key) != null }

internal fun textPaint(mode: TextMode, text: String, entities: Set<String>, names: Set<String>): List<PaintSpan> = when (mode) {
	TextMode.HOLES -> holePaint(text, entities, names)
	TextMode.EXPRESSION -> consolePaint(text, entities, names)
}

internal fun textAssist(
	mode: TextMode,
	text: String,
	cursor: Int,
	description: ConsoleDescription?,
	ids: ConsoleIds?,
	names: Map<String, VariableShape?>,
): ConsoleAssist = when (mode) {
	TextMode.HOLES -> holeAssist(text, cursor, description, ids, names)
	TextMode.EXPRESSION -> consoleAssist(text, cursor, description, ids, names, noSlow = true)
}

internal fun nameInserted(mode: TextMode, text: String, cursor: Int, name: String): Pair<String, Int> = when (mode) {
	TextMode.HOLES -> withName(text, cursor, name)
	TextMode.EXPRESSION -> inserted(text, cursor, name)
}

internal fun entityInserted(mode: TextMode, text: String, cursor: Int, name: String): Pair<String, Int> = when (mode) {
	TextMode.HOLES -> withEntity(text, cursor, name)
	TextMode.EXPRESSION -> inserted(text, cursor, "$name.")
}

internal fun completionPicked(mode: TextMode, text: String, completion: ConsoleCompletion, entities: Set<String>): Pair<String, Int> =
	when (mode) {
		TextMode.HOLES -> pickCompletion(text, completion, entities)
		TextMode.EXPRESSION -> completion.applyTo(text)
	}

internal fun nameShown(mode: TextMode, name: String): String = when (mode) {
	TextMode.HOLES -> "{$name}"
	TextMode.EXPRESSION -> name
}

private fun inserted(text: String, cursor: Int, insert: String): Pair<String, Int> {
	val at = cursor.coerceIn(0, text.length)
	return text.replaceRange(at, at, insert) to at + insert.length
}

private val ESCAPED = setOf('{', '}', '\\')
private const val EVENT_NAME = "event"
private val EVENT_OWN = listOf("id", "title", "url")

/** Null when the action or text is gone. */
internal fun textParam(draft: AutomationDraft, ref: TextRef, offer: AutomationOffer): ParamOffer? {
	val action = (draft.stepAt(ref.key) as? StepDraft.Do)?.action as? ActionDraft.Filled ?: return null
	return offer.action(action.kind)?.param(ref.param)?.takeIf { it.kind == PARAM_TEXT }
}

/** Null where `textParam` is. */
internal fun textAt(draft: AutomationDraft, ref: TextRef, offer: AutomationOffer): String? {
	val action = (draft.stepAt(ref.key) as? StepDraft.Do)?.action as? ActionDraft.Filled ?: return null
	return textParam(draft, ref, offer)?.let { action.values[it.name].orEmpty() }
}

/** Unclosed hole runs to the end. */
internal fun holeAt(text: String, cursor: Int): HolePart.Hole? =
	scanHoles(text).filterIsInstance<HolePart.Hole>().firstOrNull { hole ->
		cursor > hole.start && if (hole.closed) cursor < hole.end else cursor <= hole.end
	}

/** Offsets in the whole text. */
internal fun holePaint(text: String, entities: Set<String>, names: Set<String>): List<PaintSpan> =
	scanHoles(text).flatMap { part ->
		when (part) {
			is HolePart.Text -> escapes(text, part.start, part.end)
			is HolePart.Hole -> {
				val inner = part.start + 1
				val close = if (part.closed) listOf(PaintSpan(part.end - 1, part.end, CodeToken.PUNCTUATION)) else emptyList()
				val painted = consolePaint(part.source, entities, names).map { PaintSpan(it.start + inner, it.end + inner, it.token) }
				listOf(PaintSpan(part.start, inner, CodeToken.PUNCTUATION)) + painted + close
			}
		}
	}

/** The scanner's own pairs. */
private fun escapes(text: String, from: Int, to: Int): List<PaintSpan> {
	val spans = mutableListOf<PaintSpan>()
	var at = from
	while (at < to - 1) {
		val pair = text[at] == '\\' && text[at + 1] in ESCAPED
		if (pair) spans += PaintSpan(at, at + 2, CodeToken.ESCAPE)
		at += if (pair) 2 else 1
	}
	return spans
}

/** A name a text may use; `shown` once the preview answers. */
internal data class NameHere(val name: String, val description: String, val shown: String?) {
	val says: String get() = listOfNotNull(description, shown).joinToString(" · ")
}

/** The served row's names for the trigger kind, with what each holds once answered. */
internal fun namesHere(
	offer: AutomationOffer,
	kind: String,
	answered: List<AutomationPreviewName>?,
	params: List<com.atelier_nyaarium.switchboard.proto.FunctionParam> = emptyList(),
	values: Map<String, String> = emptyMap(),
): List<NameHere> {
	val trigger = offer.names(kind).map { served -> NameHere(served.name, served.description, answered?.find { it.name == served.name }?.shown) }
	val function = params.map { param ->
		val value = values[param.name]
		val shown = if (param.type == "device") offer.switches.find { it.device == value }?.name else value
		NameHere(param.name, param.type.replaceFirstChar { it.uppercase() }, shown)
	}
	return trigger + function
}

/** Names a hole may use. */
internal fun nameShapes(names: List<NameHere>, eventFields: List<String>): Map<String, VariableShape?> =
	names.associate { name ->
		name.name to VariableShape((eventFields + EVENT_OWN).distinct(), list = false).takeIf { name.name == EVENT_NAME }
	}

/** Hint and completions under cursor. */
internal fun holeAssist(
	text: String,
	cursor: Int,
	description: ConsoleDescription?,
	ids: ConsoleIds?,
	names: Map<String, VariableShape?>,
): ConsoleAssist {
	val hole = holeAt(text, cursor) ?: return ConsoleAssist(null, emptyList())
	val inner = hole.start + 1
	val assist = consoleAssist(hole.source, cursor - inner, description, ids, names, noSlow = true)
	return assist.copy(completions = assist.completions.map { it.copy(start = it.start + inner, end = it.end + inner) })
}

/** Closes a finished hole. */
internal fun pickCompletion(text: String, completion: ConsoleCompletion, entities: Set<String>): Pair<String, Int> {
	val (next, cursor) = completion.applyTo(text)
	val hole = holeAt(text, completion.start) ?: return next to cursor
	val finishes = !hole.closed &&
		completion.end == hole.end &&
		!completion.insert.endsWith("(") &&
		completion.insert !in entities &&
		text.substring(hole.start + 1, completion.start).trimEnd().lastOrNull() != '.' &&
		openCalls(next.substring(hole.start + 1, cursor)) == 0
	return if (finishes) "${next.substring(0, cursor)}}${next.substring(cursor)}" to cursor + 1 else next to cursor
}

/** Open parenthesis count. */
private fun openCalls(source: String): Int = lexConsole(source).sumOf { token ->
	when {
		token.kind != ConsoleTokenKind.PUNCT -> 0
		token.text == "(" -> 1
		token.text == ")" -> -1
		else -> 0
	}
}

/** A space where `\{` would escape the brace. */
internal fun holeGap(text: String, at: Int): String {
	var run = 0
	while (at - run > 0 && text[at - run - 1] == '\\') run++
	return if (run % 2 == 1) " " else ""
}

/** Bare inside a hole, else its own hole. */
internal fun withName(text: String, cursor: Int, name: String): Pair<String, Int> {
	val at = cursor.coerceIn(0, text.length)
	val insert = if (holeAt(text, at) != null) name else "${holeGap(text, at)}{$name}"
	return text.replaceRange(at, at, insert) to at + insert.length
}

/** Cursor lands where a member goes. */
internal fun withEntity(text: String, cursor: Int, name: String): Pair<String, Int> {
	val at = cursor.coerceIn(0, text.length)
	val inside = holeAt(text, at) != null
	val insert = if (inside) "$name." else "${holeGap(text, at)}{$name.}"
	return text.replaceRange(at, at, insert) to at + insert.length - if (inside) 0 else 1
}

/** Refused span, clamped. */
internal fun refusedSpan(text: String, preview: TextPreview, refused: AutomationSaid.Hole?): IntRange? {
	val (start, end) = when {
		preview is TextPreview.Refused -> preview.start to preview.end
		refused != null -> refused.start to refused.end
		else -> return null
	}
	return spanOf(text, start, end)
}

/** Clamped condition span. */
internal fun conditionSpan(text: String, preview: ConditionPreview, refused: AutomationSaid.Hole?): IntRange? {
	val (start, end) = when {
		preview is ConditionPreview.Refused -> preview.start to preview.end
		refused != null -> refused.start to refused.end
		else -> return null
	}
	return spanOf(text, start, end)
}

private fun spanOf(text: String, start: Int, end: Int): IntRange {
	val from = start.coerceIn(0, text.length)
	val to = end.coerceIn(from, text.length)
	// Empty span still marks.
	return if (to > from) from until to else (from - 1).coerceAtLeast(0)..from.coerceAtMost(text.length - 1)
}
