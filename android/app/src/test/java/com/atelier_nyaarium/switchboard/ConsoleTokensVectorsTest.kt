package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
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

	@Test
	fun theTokensMatchTheGrammar() {
		val cases = vectors["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val expected =
				o["tokens"]!!.jsonArray.map { token ->
					val t = token.jsonObject
					listOf(
						t["kind"]!!.jsonPrimitive.content,
						t["text"]!!.jsonPrimitive.content,
						t["start"]!!.jsonPrimitive.int,
						t["end"]!!.jsonPrimitive.int,
						t["closed"]?.jsonPrimitive?.booleanOrNull,
						t["value"]?.jsonPrimitive?.content,
					)
				}
			val actual =
				lexConsole(o["input"]!!.jsonPrimitive.content).map {
					listOf(it.kind.wire, it.text, it.start, it.end, it.closed, it.value)
				}
			assertEquals(name, expected, actual)
		}
	}
}
