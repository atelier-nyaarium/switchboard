package com.atelier_nyaarium.switchboard.liveconsole

import com.atelier_nyaarium.switchboard.CodeToken
import com.atelier_nyaarium.switchboard.ConsoleEntryState
import com.atelier_nyaarium.switchboard.ConsoleVocabulary
import com.atelier_nyaarium.switchboard.GATEWAY_UNREACHABLE
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.ViewScope
import com.atelier_nyaarium.switchboard.addressOf
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleMemberDescription
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
						// An entity outranks a saved name.
						token.text in entities -> CodeToken.TYPE
						token.text in variables -> CodeToken.VARIABLE
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

/** A superset; the Gateway decides references. */
fun variablesFor(expr: String, held: Map<String, ConsoleVariable>): JsonObject? {
	val named = lexConsole(expr).filter { it.kind == ConsoleTokenKind.IDENT }.map { it.text }.toSet()
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

/** Margin under the Gateway's cap. */
private const val VARIABLES_BYTES = Protocol.Wire.CONSOLE_VARIABLES_BYTES / 4 * 3

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

/** A dot takes a keyword too. */
private fun isName(key: String): Boolean =
	lexConsole(key).singleOrNull()?.let {
		(it.kind == ConsoleTokenKind.IDENT || it.kind == ConsoleTokenKind.KEYWORD) && it.text == key
	} == true

internal const val CONSOLE_RECALL_SHOWN = 20

/** The picker shows only for the whole view. */
internal fun picksGateway(scope: ViewScope, roster: GatewayRegistry): Boolean =
	scope == ViewScope.Everything && roster.ids().size > 1

internal fun noGatewayLine(roster: GatewayRegistry): String = if (roster.loaded) "No Gateway" else "No roster yet"

internal fun canRun(draft: String): Boolean = draft.isNotBlank()

/** What one history row draws under its input. */
internal sealed interface EntryDrawn {
	data object Running : EntryDrawn

	data class Said(val line: String) : EntryDrawn

	data class Cards(val cards: List<ConsoleDrawn>) : EntryDrawn
}

internal fun entryDrawn(state: ConsoleEntryState, description: ConsoleDescription?, now: Long): EntryDrawn =
	when (state) {
		ConsoleEntryState.Running -> EntryDrawn.Running
		ConsoleEntryState.Unreachable -> EntryDrawn.Said(GATEWAY_UNREACHABLE)
		is ConsoleEntryState.Refused -> EntryDrawn.Said(state.reason)
		is ConsoleEntryState.Answered -> EntryDrawn.Cards(cardsOf(state.result, description, now))
	}

/** Null when the list is whole. */
internal fun moreLine(card: ConsoleCard.Rows): String? =
	if (card.more > 0) "${card.more} more; add .skip(${card.rows.size})" else null

private fun isMethod(member: ConsoleMemberDescription) = member.kind == "method"

internal fun memberSignature(member: ConsoleMemberDescription): String {
	val params = member.params.joinToString(", ") { "${it.name}${if (it.optional) "?" else ""}: ${it.type}" }
	return "${member.name}${if (isMethod(member)) "($params)" else ""} -> ${member.returns}"
}

/** What a tap on a member types. */
internal fun memberInsert(entity: ConsoleEntityDescription, member: ConsoleMemberDescription): String =
	"${entity.name}.${member.name}${if (isMethod(member)) "(" else ""}"

