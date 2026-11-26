package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleStringPart
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleToken
import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import com.atelier_nyaarium.switchboard.liveconsole.lexConsoleText
import com.atelier_nyaarium.switchboard.liveconsole.lexScript
import com.atelier_nyaarium.switchboard.liveconsole.quoteConsoleString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class ConsoleTokensVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("live-console-tokens/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	/** A token as the corpus writes it, holes and all. */
	private fun wire(token: ConsoleToken): JsonElement =
		JsonObject(
			buildMap {
				put("kind", JsonPrimitive(token.kind.wire))
				put("text", JsonPrimitive(token.text))
				put("start", JsonPrimitive(token.start))
				put("end", JsonPrimitive(token.end))
				token.closed?.let { put("closed", JsonPrimitive(it)) }
				token.value?.let { put("value", JsonPrimitive(it)) }
				token.parts?.let { parts -> put("parts", JsonArray(parts.map(::wire))) }
			},
		)

	private fun wire(part: ConsoleStringPart): JsonElement =
		JsonObject(
			buildMap {
				put("start", JsonPrimitive(part.start))
				put("end", JsonPrimitive(part.end))
				when (part) {
					is ConsoleStringPart.Text -> {
						put("kind", JsonPrimitive("text"))
						put("value", JsonPrimitive(part.value))
					}
					is ConsoleStringPart.Escape -> {
						put("kind", JsonPrimitive("escape"))
						put("value", JsonPrimitive(part.value))
					}
					is ConsoleStringPart.Hole -> {
						put("kind", JsonPrimitive("hole"))
						put("tokens", JsonArray(part.tokens.map(::wire)))
						put("closed", JsonPrimitive(part.closed))
					}
				}
			},
		)

	private fun replay(section: String, field: String, read: (String) -> JsonElement) {
		val cases = vectors[section]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			assertEquals(o["name"]!!.jsonPrimitive.content, o[field], read(o["input"]!!.jsonPrimitive.content))
		}
	}

	@Test
	fun anExpressionLexesAsTheGrammarDoes() =
		replay("cases", "tokens") { input -> JsonArray(lexConsole(input).map(::wire)) }

	@Test
	fun aTextLexesAsAStringBodyWithNoQuote() =
		replay("texts", "parts") { input -> JsonArray(lexConsoleText(input).map(::wire)) }

	@Test
	fun aConstantIsQuotedAsTheGrammarWritesIt() =
		replay("strings", "quoted") { input -> JsonPrimitive(quoteConsoleString(input)) }

	@Test
	fun aScriptLexesItsCommentsAndLineBreaks() =
		replay("scripts", "tokens") { input -> JsonArray(lexScript(input).map(::wire)) }
}
