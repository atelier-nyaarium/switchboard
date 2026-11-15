package com.atelier_nyaarium.switchboard.liveconsole

import com.atelier_nyaarium.switchboard.CodeToken
import com.atelier_nyaarium.switchboard.ConsoleVocabulary
import com.atelier_nyaarium.switchboard.GATEWAY_UNREACHABLE
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.ViewScope
import com.atelier_nyaarium.switchboard.addressOf
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Session scope ignores picks. */
internal fun consoleGatewayOf(scope: ViewScope, roster: GatewayRegistry, picked: String?): String? =
	when (scope) {
		is ViewScope.Session -> addressOf(scope.team)?.gateway
		ViewScope.Everything ->
			picked?.takeIf { roster.has(it) } ?: roster.reachableIds().firstOrNull() ?: roster.ids().firstOrNull()
	}

internal data class PaintSpan(val start: Int, val end: Int, val token: CodeToken)

internal fun consolePaint(source: String, entities: Set<String>, variables: Set<String>): List<PaintSpan> {
	val tokens = lexConsole(source)
	return tokens.mapIndexed { at, token ->
		val afterDot = tokens.getOrNull(at - 1)?.let { it.kind == ConsoleTokenKind.PUNCT && it.text == "." } == true
		val paint =
			when (token.kind) {
				ConsoleTokenKind.IDENT ->
					when {
						afterDot -> CodeToken.FUNCTION
						token.text in variables -> CodeToken.VARIABLE
						token.text in entities -> CodeToken.TYPE
						else -> CodeToken.PROPERTY
					}
				ConsoleTokenKind.NUMBER -> CodeToken.NUMBER
				ConsoleTokenKind.STRING -> CodeToken.STRING
				ConsoleTokenKind.KEYWORD -> CodeToken.KEYWORD
				ConsoleTokenKind.OP -> CodeToken.OPERATOR
				ConsoleTokenKind.PUNCT -> CodeToken.PUNCTUATION
				ConsoleTokenKind.ERROR -> CodeToken.DELETION
			}
		PaintSpan(token.start, token.end, paint)
	}
}

data class ConsoleVariable(val value: JsonElement, val type: String?)


/** Send referenced variables only. */
fun variablesFor(expr: String, held: Map<String, ConsoleVariable>): JsonObject? {
	val tokens = lexConsole(expr)
	val named = mutableSetOf<String>()
	// A save hides the held value from later statements.
	val saved = mutableSetOf<String>()
	var target: String? = null
	tokens.forEachIndexed { at, token ->
		val before = tokens.getOrNull(at - 1)
		val after = tokens.getOrNull(at + 1)
		if (token.kind == ConsoleTokenKind.PUNCT && token.text == ";") {
			target?.let { saved += it }
			target = null
			return@forEachIndexed
		}
		if (token.kind != ConsoleTokenKind.IDENT) return@forEachIndexed
		val opens = before == null || (before.kind == ConsoleTokenKind.PUNCT && before.text == ";")
		if (opens && after?.kind == ConsoleTokenKind.OP && after.text == "=") {
			target = token.text
			return@forEachIndexed
		}
		// Skip keys and member refs.
		val member = before?.kind == ConsoleTokenKind.PUNCT && before.text == "."
		val key = after?.kind == ConsoleTokenKind.PUNCT && after.text == ":"
		if (!member && !key && token.text !in saved) named += token.text
	}
	val sent = held.filterKeys { it in named }
	if (sent.isEmpty()) return null
	return buildJsonObject {
		for ((name, variable) in sent) {
			put(
				name,
				buildJsonObject {
					put("value", variable.value)
					variable.type?.let { put("type", it) }
				},
			)
		}
	}
}

/** Under what one read may send. */
private const val VARIABLES_BYTES = Protocol.Wire.CONSOLE_VALUE_BYTES * 3

private fun sizeOf(variable: ConsoleVariable): Int = variable.value.toString().toByteArray(Charsets.UTF_8).size

/** Newest saves evict oldest, by count and by size. */
fun withVariable(held: Map<String, ConsoleVariable>, name: String, variable: ConsoleVariable): Map<String, ConsoleVariable> {
	val kept = ((held - name) + (name to variable)).entries.toList().takeLast(Protocol.Wire.CONSOLE_VARIABLES_MAX).toMutableList()
	while (kept.size > 1 && kept.sumOf { sizeOf(it.value) } > VARIABLES_BYTES) kept.removeAt(0)
	return kept.associate { it.key to it.value }
}

fun variableLabel(variable: ConsoleVariable): String =
	variable.type ?: when (val value = variable.value) {
		is JsonArray -> if (value.size == 1) "1 item" else "${value.size} items"
		is JsonObject -> "record"
		is JsonNull -> "none"
		is JsonPrimitive -> value.content.take(16)
	}

data class VariableShape(val fields: List<String>, val list: Boolean)

fun variableShapes(held: Map<String, ConsoleVariable>): Map<String, VariableShape?> =
	held.mapValues { (_, variable) ->
		when (val value = variable.value) {
			// A dot takes only a name.
			is JsonObject -> VariableShape(value.keys.filter(::isName), list = false)
			is JsonArray -> VariableShape(emptyList(), list = true)
			else -> null
		}
	}

internal fun vocabularyLine(vocabulary: ConsoleVocabulary): String =
	when (vocabulary) {
		ConsoleVocabulary.Loading, ConsoleVocabulary.Ready -> "Loading"
		ConsoleVocabulary.Unreachable -> GATEWAY_UNREACHABLE
		is ConsoleVocabulary.Refused -> "This Gateway does not serve the console: ${vocabulary.reason}"
	}

private fun isName(key: String): Boolean = lexConsole(key).singleOrNull()?.let { it.kind == ConsoleTokenKind.IDENT && it.text == key } == true
