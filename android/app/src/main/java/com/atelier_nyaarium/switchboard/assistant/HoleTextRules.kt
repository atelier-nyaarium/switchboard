package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.CodeToken
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleAssist
import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.PaintSpan
import com.atelier_nyaarium.switchboard.liveconsole.VariableShape
import com.atelier_nyaarium.switchboard.liveconsole.consoleAssist
import com.atelier_nyaarium.switchboard.liveconsole.consolePaint
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleIds

/** Text slot by action and parameter. */
internal data class TextRef(val action: Int, val param: String)

private val ESCAPED = setOf('{', '}', '\\')
private const val EVENT_NAME = "event"
private val EVENT_OWN = listOf("id", "title", "url")

/** Null once the action is gone. */
internal fun textAt(draft: AutomationDraft, ref: TextRef): String? = when (val action = draft.actions.getOrNull(ref.action)) {
	is ActionDraft.Tell -> action.message.takeIf { ref.param == PARAM_MESSAGE }
	is ActionDraft.Ifttt -> when (ref.param) {
		PARAM_VALUE1 -> action.value1
		PARAM_VALUE2 -> action.value2
		PARAM_VALUE3 -> action.value3
		else -> null
	}
	is ActionDraft.DeviceSet, is ActionDraft.Kept, null -> null
}

internal fun textLabel(ref: TextRef): String = when (ref.param) {
	PARAM_MESSAGE -> "Message"
	PARAM_VALUE1 -> "Value 1"
	PARAM_VALUE2 -> "Value 2"
	PARAM_VALUE3 -> "Value 3"
	else -> "Text"
}

/** Wire cap. */
internal fun textMax(ref: TextRef): Int = if (ref.param == PARAM_MESSAGE) MAX_MESSAGE_LEN else MAX_IFTTT_VALUE_LEN

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

/** Names a hole may use. */
internal fun nameShapes(names: List<AutomationPreviewName>, eventFields: List<String>): Map<String, VariableShape?> =
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
	val assist = consoleAssist(hole.source, cursor - inner, description, ids, names)
	return assist.copy(completions = assist.completions.map { it.copy(start = it.start + inner, end = it.end + inner) })
}

/** Bare inside a hole, else its own hole. */
internal fun withName(text: String, cursor: Int, name: String): Pair<String, Int> {
	val at = cursor.coerceIn(0, text.length)
	val insert = if (holeAt(text, at) != null) name else "{$name}"
	return text.replaceRange(at, at, insert) to at + insert.length
}

/** Cursor lands where a member goes. */
internal fun withEntity(text: String, cursor: Int, name: String): Pair<String, Int> {
	val at = cursor.coerceIn(0, text.length)
	val inside = holeAt(text, at) != null
	val insert = if (inside) "$name." else "{$name.}"
	return text.replaceRange(at, at, insert) to at + insert.length - if (inside) 0 else 1
}

/** Refused span, clamped. */
internal fun refusedSpan(text: String, preview: TextPreview, refused: AutomationSaid.Hole?): IntRange? {
	val (start, end) = when {
		preview is TextPreview.Refused -> preview.start to preview.end
		refused != null -> refused.start to refused.end
		else -> return null
	}
	val from = start.coerceIn(0, text.length)
	val to = end.coerceIn(from, text.length)
	// Empty span still marks.
	return if (to > from) from until to else (from - 1).coerceAtLeast(0)..from.coerceAtMost(text.length - 1)
}
