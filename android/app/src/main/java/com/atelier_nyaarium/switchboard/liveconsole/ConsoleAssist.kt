package com.atelier_nyaarium.switchboard.liveconsole

import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceIds
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import com.atelier_nyaarium.switchboard.proto.Protocol

data class ConsoleCompletion(val label: String, val insert: String, val start: Int, val end: Int)

data class ConsoleHint(val name: String, val params: List<String>, val active: Int, val returns: String, val note: String?)

data class ConsoleAssist(val hint: ConsoleHint?, val completions: List<ConsoleCompletion>)

/** `free`: called with no receiver. */
private data class OpenCall(val owner: String?, val method: String, val commas: Int, val args: List<String?>, val free: Boolean)

private const val COMPLETIONS_MAX = 12
private const val NO_RECEIVER = "none"
private val EXPRESSION_OPENERS = setOf("(", "[", "{", ",", ":")

private fun quoted(text: String) = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

private fun openCall(tokens: List<ConsoleToken>): OpenCall? {
	data class Frame(val open: Char, val at: Int)
	val stack = ArrayDeque<Frame>()
	tokens.forEachIndexed { at, token ->
		if (token.kind != ConsoleTokenKind.PUNCT) return@forEachIndexed
		when (token.text) {
			"(", "[", "{" -> stack.addLast(Frame(token.text[0], at))
			")", "]", "}" -> stack.removeLastOrNull()
		}
	}
	val paren = stack.lastOrNull { it.open == '(' } ?: return null
	if (stack.last() !== paren) return null
	val name = tokens.getOrNull(paren.at - 1)?.takeIf { it.kind == ConsoleTokenKind.IDENT } ?: return null
	val free = !isPunct(tokens.getOrNull(paren.at - 2), ".")
	val target = tokens.getOrNull(paren.at - 3)
	val owner =
		target?.takeIf {
			!free && it.kind == ConsoleTokenKind.IDENT && !isPunct(tokens.getOrNull(paren.at - 4), ".")
		}?.text
	var depth = 0
	var commas = 0
	val args = mutableListOf<String?>(null)
	for (token in tokens.drop(paren.at + 1)) {
		if (token.kind == ConsoleTokenKind.PUNCT && token.text in setOf("(", "[", "{")) depth++
		if (token.kind == ConsoleTokenKind.PUNCT && token.text in setOf(")", "]", "}")) depth--
		if (depth == 0 && token.kind == ConsoleTokenKind.PUNCT && token.text == ",") {
			commas++
			args += null
		} else if (depth == 0 && token.kind == ConsoleTokenKind.STRING) {
			args[args.lastIndex] = token.value
		}
	}
	return OpenCall(owner, name.text, commas, args, free)
}

private fun hintOf(call: OpenCall, description: ConsoleDescription): ConsoleHint? {
	val entity = description.entities.firstOrNull { !call.free && it.name == call.owner }
	val member = entity?.members?.firstOrNull { it.name == call.method && it.kind == "method" }
	if (member != null) {
		val params = member.params.map { "${it.name}${if (it.optional) "?" else ""}: ${it.type}" }
		val active = call.commas.coerceAtMost((member.params.size - 1).coerceAtLeast(0))
		val note = member.params.getOrNull(active)?.let { "${it.name}: ${it.description}" }
		return ConsoleHint("${entity.name}.${member.name}", params, active, member.returns, note)
	}
	val builtin = description.builtins.firstOrNull { it.name == call.method && (it.receiver == NO_RECEIVER) == call.free } ?: return null
	return ConsoleHint(
		builtin.name,
		builtin.params.map { "${it.name}${if (it.optional == true) "?" else ""}: ${it.type}" },
		call.commas.coerceAtMost((builtin.params.size - 1).coerceAtLeast(0)),
		builtin.returns,
		builtin.description,
	)
}

private data class Choice(val label: String, val value: String)

/** A name another device shares completes by id. */
private fun named(offered: List<ConsoleDeviceIds>, all: List<ConsoleDeviceIds>): List<Choice> {
	val shared = all.groupingBy { it.name.lowercase() }.eachCount()
	return offered.map {
		if ((shared[it.name.lowercase()] ?: 0) > 1) Choice("${it.name} · ${it.id}", it.id) else Choice(it.name, it.name)
	}
}

private fun argumentChoices(call: OpenCall, description: ConsoleDescription, ids: ConsoleIds?): List<Choice> {
	if (ids == null) return emptyList()
	val member =
		description.entities.firstOrNull { it.name == call.owner }?.members?.firstOrNull { it.name == call.method }
			?: return emptyList()
	val param = member.params.getOrNull(call.commas) ?: return emptyList()
	val plain = { values: List<String> -> values.map { Choice(it, it) } }
	// A kind this build does not know offers nothing.
	val kind = Protocol.Wire.ConsoleCompletes.entries.firstOrNull { it.wire == param.completes } ?: return emptyList()
	return when (kind) {
		Protocol.Wire.ConsoleCompletes.DEVICES -> named(ids.devices, ids.devices)
		// A sensor is a device with readings.
		Protocol.Wire.ConsoleCompletes.SENSORS -> named(ids.devices.filter { it.readings.isNotEmpty() }, ids.devices)
		Protocol.Wire.ConsoleCompletes.READINGS -> {
			val device = call.args.firstOrNull()?.lowercase()
			plain(
				ids.devices.filter { device == null || it.name.lowercase() == device || it.id == device }
					.flatMap { it.readings }
					.distinct(),
			)
		}
		Protocol.Wire.ConsoleCompletes.FIELDS -> plain(ids.fields.map { it.id })
		Protocol.Wire.ConsoleCompletes.AUTOMATIONS -> plain(ids.automations.map { it.id })
		Protocol.Wire.ConsoleCompletes.SOURCES -> plain(ids.sources.map { it.id })
		Protocol.Wire.ConsoleCompletes.DEFINITIONS -> plain(ids.definitions)
	}
}

private fun isPunct(token: ConsoleToken?, text: String) = token?.kind == ConsoleTokenKind.PUNCT && token.text == text

private fun savedBy(statements: List<ConsoleToken>): Set<String> =
	statements.filterIndexed { at, token ->
		val opens = at == 0 || isPunct(statements[at - 1], ";")
		val equals = statements.getOrNull(at + 1)
		opens && token.kind == ConsoleTokenKind.IDENT && equals?.kind == ConsoleTokenKind.OP && equals.text == "="
	}.map { it.text }.toSet()

private enum class SlotKind { NAME, STRING, EMPTY, NONE }

/** What a completion replaces. */
private data class Slot(val kind: SlotKind, val start: Int, val end: Int, val typed: String)

private fun slotOf(source: String, token: ConsoleToken, cursor: Int): Slot? {
	if (token.kind == ConsoleTokenKind.IDENT || token.kind == ConsoleTokenKind.KEYWORD) {
		return Slot(SlotKind.NAME, token.start, token.end, source.substring(token.start, cursor))
	}
	if (token.kind != ConsoleTokenKind.STRING) return null
	// Decode typed strings with the lexer.
	val typed = lexConsole(source.substring(token.start, cursor)).firstOrNull()?.value.orEmpty()
	return when {
		// Open strings consume the remainder.
		token.closed != true -> Slot(SlotKind.STRING, token.start, cursor, typed)
		cursor < token.end -> Slot(SlotKind.STRING, token.start, token.end, typed)
		else -> null
	}
}

/** The token the cursor touches, either side. */
private fun slotAt(source: String, tokens: List<ConsoleToken>, cursor: Int): Slot {
	val left = tokens.lastOrNull { it.start < cursor && cursor <= it.end }
	val right = tokens.firstOrNull { it.start == cursor }
	val inside = left != null && cursor < left.end
	// Text against a number would join it.
	val joins = right?.kind == ConsoleTokenKind.NUMBER || right?.kind == ConsoleTokenKind.ERROR
	return left?.let { slotOf(source, it, cursor) }
		?: right?.let { slotOf(source, it, cursor) }
		?: Slot(if (inside || joins) SlotKind.NONE else SlotKind.EMPTY, cursor, cursor, "")
}

private fun memberNames(
	tokens: List<ConsoleToken>,
	description: ConsoleDescription,
	variables: Map<String, VariableShape?>,
	local: Set<String>,
	noSlow: Boolean,
): List<Pair<String, String>> {
	val owner = tokens.getOrNull(tokens.size - 2)
	val bare = owner?.kind == ConsoleTokenKind.IDENT && !isPunct(tokens.getOrNull(tokens.size - 3), ".")
	val entity = description.entities.firstOrNull { bare && it.name == owner?.text }
	if (entity != null) {
		return entity.members.filterNot { noSlow && it.slow }.map { it.name to if (it.kind == "method") "${it.name}(" else it.name }
	}
	val saved = owner?.text?.takeIf { bare && it in variables && it !in local }
	val shape = saved?.let { variables[it] }
	// Scalars offer no members.
	val receivers =
		when {
			saved == null -> setOf("list", "object", "collection")
			shape == null -> emptySet()
			shape.list -> setOf("list", "collection")
			else -> setOf("object", "collection")
		}
	return shape?.fields.orEmpty().map { it to it } +
		description.builtins.filter { it.receiver in receivers }.map { it.name to "${it.name}(" }
}

/** `noSlow`: where a slow member is refused. */
fun consoleAssist(
	source: String,
	cursor: Int,
	description: ConsoleDescription?,
	ids: ConsoleIds?,
	variables: Map<String, VariableShape?>,
	noSlow: Boolean = false,
): ConsoleAssist {
	if (description == null) return ConsoleAssist(null, emptyList())
	val all = lexConsole(source)
	val slot = slotAt(source, all, cursor)
	val before = all.filter { it.start < slot.start }
	// Complete only the statement under the cursor.
	val cut = before.indexOfLast { isPunct(it, ";") } + 1
	val tokens = before.drop(cut)
	val local = savedBy(before.take(cut))
	val call = openCall(tokens)
	val hint = call?.let { hintOf(it, description) }
	val prior = tokens.lastOrNull()
	val arguments = { call?.let { argumentChoices(it, description, ids) }.orEmpty() }

	val offered: List<Pair<String, String>> =
		when {
			slot.kind == SlotKind.NONE -> emptyList()
			slot.kind == SlotKind.STRING ->
				arguments()
					.filter { it.value.startsWith(slot.typed, ignoreCase = true) || it.label.startsWith(slot.typed, ignoreCase = true) }
					.map { it.label to quoted(it.value) }
			slot.typed.isEmpty() && (isPunct(prior, "(") || isPunct(prior, ",")) && arguments().isNotEmpty() ->
				arguments().map { it.label to quoted(it.value) }
			else -> {
				val names =
					if (isPunct(prior, ".")) {
						memberNames(tokens, description, variables, local, noSlow)
					} else if (prior == null || prior.kind == ConsoleTokenKind.OP ||
						(prior.kind == ConsoleTokenKind.PUNCT && prior.text in EXPRESSION_OPENERS)
					) {
						((variables.keys + local).sorted() + description.entities.map { it.name }).map { it to it } +
							description.builtins.filter { it.receiver == NO_RECEIVER }.map { it.name to "${it.name}(" }
					} else {
						emptyList()
					}
				names.filter { (name, _) -> name.startsWith(slot.typed) && name != slot.typed }
			}
		}
	val next = all.firstOrNull { it.start >= slot.end }
	return ConsoleAssist(
		hint,
		offered.take(COMPLETIONS_MAX).map { (label, insert) ->
			// An existing bracket is reused.
			val end = if (next != null && insert.endsWith("(") && isPunct(next, "(")) next.end else slot.end
			ConsoleCompletion(label, insert, slot.start, end)
		},
	)
}

fun ConsoleCompletion.applyTo(source: String): Pair<String, Int> {
	val from = start.coerceIn(0, source.length)
	val to = end.coerceIn(from, source.length)
	return source.replaceRange(from, to, insert) to from + insert.length
}
