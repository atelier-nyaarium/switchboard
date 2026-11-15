package com.atelier_nyaarium.switchboard.liveconsole

import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleIds

data class ConsoleCompletion(val label: String, val insert: String, val start: Int, val end: Int)

data class ConsoleHint(val name: String, val params: List<String>, val active: Int, val returns: String, val note: String?)

data class ConsoleAssist(val hint: ConsoleHint?, val completions: List<ConsoleCompletion>)

private data class OpenCall(val owner: String?, val method: String, val commas: Int, val args: List<String?>)

private const val COMPLETIONS_MAX = 12
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
	val dot = tokens.getOrNull(paren.at - 2)?.takeIf { it.kind == ConsoleTokenKind.PUNCT && it.text == "." } ?: return null
	val target = tokens.getOrNull(paren.at - 3)
	val owner =
		target?.takeIf {
			it.kind == ConsoleTokenKind.IDENT && tokens.getOrNull(paren.at - 4)?.text != "."
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
	return OpenCall(owner, name.text, commas, args).takeIf { dot.end <= name.start }
}

private fun hintOf(call: OpenCall, description: ConsoleDescription): ConsoleHint? {
	val entity = description.entities.firstOrNull { it.name == call.owner }
	val member = entity?.members?.firstOrNull { it.name == call.method && it.kind == "method" }
	if (member != null) {
		val params = member.params.map { "${it.name}${if (it.optional) "?" else ""}: ${it.type}" }
		val active = call.commas.coerceAtMost((member.params.size - 1).coerceAtLeast(0))
		val note = member.params.getOrNull(active)?.let { "${it.name}: ${it.description}" }
		return ConsoleHint("${entity.name}.${member.name}", params, active, member.returns, note)
	}
	val builtin = description.builtins.firstOrNull { it.name == call.method } ?: return null
	return ConsoleHint(
		builtin.name,
		builtin.params.map { "${it.name}: ${it.type}" },
		call.commas.coerceAtMost((builtin.params.size - 1).coerceAtLeast(0)),
		builtin.returns,
		builtin.description,
	)
}

private data class Choice(val label: String, val value: String)

private fun argumentChoices(call: OpenCall, description: ConsoleDescription, ids: ConsoleIds?): List<Choice> {
	if (ids == null) return emptyList()
	val member =
		description.entities.firstOrNull { it.name == call.owner }?.members?.firstOrNull { it.name == call.method }
			?: return emptyList()
	val param = member.params.getOrNull(call.commas) ?: return emptyList()
	val plain = { values: List<String> -> values.map { Choice(it, it) } }
	return when (param.completes) {
		"devices" -> {
			val shared = ids.devices.groupingBy { it.name.lowercase() }.eachCount()
			// Resolve duplicate names by ID.
			ids.devices.map {
				if ((shared[it.name.lowercase()] ?: 0) > 1) Choice("${it.name} · ${it.id}", it.id) else Choice(it.name, it.name)
			}
		}
		"readings" -> {
			val device = call.args.firstOrNull()?.lowercase()
			plain(
				ids.devices.filter { device == null || it.name.lowercase() == device || it.id == device }
					.flatMap { it.readings }
					.distinct(),
			)
		}
		"fields" -> plain(ids.fields.map { it.id })
		"automations" -> plain(ids.automations.map { it.id })
		"sources" -> plain(ids.sources.map { it.id })
		"definitions" -> plain(ids.definitions)
		else -> emptyList()
	}
}

private fun isPunct(token: ConsoleToken?, text: String) = token?.kind == ConsoleTokenKind.PUNCT && token.text == text

private fun savedEarlier(tokens: List<ConsoleToken>): Set<String> =
	tokens.filterIndexed { at, token ->
		val opens = at == 0 || isPunct(tokens[at - 1], ";")
		val equals = tokens.getOrNull(at + 1)
		opens && token.kind == ConsoleTokenKind.IDENT && equals?.kind == ConsoleTokenKind.OP && equals.text == "="
	}.map { it.text }.toSet()

fun consoleAssist(
	source: String,
	cursor: Int,
	description: ConsoleDescription?,
	ids: ConsoleIds?,
	variables: Map<String, VariableShape?>,
): ConsoleAssist {
	if (description == null) return ConsoleAssist(null, emptyList())
	val all = lexConsole(source)
	val before = all.filter { it.start < cursor }
	// Complete only the statement under the cursor.
	val tokens = before.drop(before.indexOfLast { isPunct(it, ";") } + 1)
	val local = savedEarlier(before)
	val call = openCall(tokens)
	val hint = call?.let { hintOf(it, description) }
	val touching = tokens.lastOrNull()?.takeIf { it.end >= cursor }

	val inString = touching?.kind == ConsoleTokenKind.STRING && (touching.closed != true || cursor < touching.end)
	if (touching != null && inString && call != null) {
		val typed = source.substring(touching.start + 1, cursor)
		// Open strings end at the cursor.
		val end = if (touching.closed == true) touching.end else cursor
		val choices =
			argumentChoices(call, description, ids).filter {
				it.value.startsWith(typed, ignoreCase = true) || it.label.startsWith(typed, ignoreCase = true)
			}
		return ConsoleAssist(
			hint,
			choices.take(COMPLETIONS_MAX).map { ConsoleCompletion(it.label, quoted(it.value), touching.start, end) },
		)
	}

	val prefix = touching?.takeIf { it.kind == ConsoleTokenKind.IDENT || it.kind == ConsoleTokenKind.KEYWORD }
	// A name starting at the cursor is replaced too.
	val following = all.firstOrNull { it.start == cursor && it.kind == ConsoleTokenKind.IDENT }
	val start = prefix?.start ?: cursor
	val end = prefix?.end ?: following?.end ?: cursor
	val typed = prefix?.text?.substring(0, cursor - prefix.start).orEmpty()
	val priorAt = tokens.size - (if (prefix != null) 2 else 1)
	val prior = tokens.getOrNull(priorAt)
	val argumentStart = prefix == null && (isPunct(prior, "(") || isPunct(prior, ","))

	if (argumentStart && call != null) {
		val choices = argumentChoices(call, description, ids)
		return ConsoleAssist(
			hint,
			choices.take(COMPLETIONS_MAX).map { ConsoleCompletion(it.label, quoted(it.value), cursor, cursor) },
		)
	}
	val names: List<Pair<String, String>> =
		if (isPunct(prior, ".")) {
			val owner = tokens.getOrNull(priorAt - 1)
			val bare = owner?.kind == ConsoleTokenKind.IDENT && !isPunct(tokens.getOrNull(priorAt - 2), ".")
			val entity = description.entities.firstOrNull { bare && it.name == owner?.text }
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
			entity?.members?.map { it.name to if (it.kind == "method") "${it.name}(" else it.name }
				?: (shape?.fields.orEmpty().map { it to it } +
					description.builtins.filter { it.receiver in receivers }.map { it.name to "${it.name}(" })
		} else if (prior == null || prior.kind == ConsoleTokenKind.OP ||
			(prior.kind == ConsoleTokenKind.PUNCT && prior.text in EXPRESSION_OPENERS)
		) {
			((variables.keys + local).sorted() + description.entities.map { it.name }).map { it to it }
		} else {
			emptyList()
		}
	val offered = names.filter { (name, _) -> name.startsWith(typed) && name != typed }.take(COMPLETIONS_MAX)
	return ConsoleAssist(hint, offered.map { (name, insert) -> ConsoleCompletion(name, insert, start, end) })
}

fun ConsoleCompletion.applyTo(source: String): Pair<String, Int> {
	val from = start.coerceIn(0, source.length)
	val to = end.coerceIn(from, source.length)
	return source.replaceRange(from, to, insert) to from + insert.length
}
