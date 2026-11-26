package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleVariable
import com.atelier_nyaarium.switchboard.liveconsole.consolePaint
import com.atelier_nyaarium.switchboard.liveconsole.variablesFor
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class ConsoleRulesTest {
	@Test
	fun stringsPaintRunsEscapesAndNestedHoleCode() {
		val source = "\"A \\{x\\} \\\\ \\n {round(\"{value}\")}\""
		val painted = consolePaint(source, setOf("sensors"), setOf("value")).map {
			source.substring(it.start, it.end) to it.token
		}

		assertEquals(
			listOf(
				"\"" to CodeToken.STRING,
				"A " to CodeToken.STRING,
				"\\{" to CodeToken.ESCAPE,
				"x" to CodeToken.STRING,
				"\\}" to CodeToken.ESCAPE,
				" " to CodeToken.STRING,
				"\\\\" to CodeToken.ESCAPE,
				" " to CodeToken.STRING,
				"\\n" to CodeToken.ESCAPE,
				" " to CodeToken.STRING,
				"{" to CodeToken.PUNCTUATION,
				"round" to CodeToken.FUNCTION,
				"(" to CodeToken.PUNCTUATION,
				"\"" to CodeToken.STRING,
				"{" to CodeToken.PUNCTUATION,
				"value" to CodeToken.VARIABLE,
				"}" to CodeToken.PUNCTUATION,
				"\"" to CodeToken.STRING,
				")" to CodeToken.PUNCTUATION,
				"}" to CodeToken.PUNCTUATION,
				"\"" to CodeToken.STRING,
			),
			painted,
		)
	}

	@Test
	fun aNameInsideAStringsHoleIsSentWithTheRead() {
		val held = mapOf(
			"kept" to ConsoleVariable(JsonPrimitive(1), null),
			"other" to ConsoleVariable(JsonPrimitive(2), null),
		)

		assertEquals(setOf("kept"), variablesFor("\"is {round(kept)}\"", held)?.keys)
		assertEquals(null, variablesFor("\"is \\{kept\\}\"", held))
	}
}
