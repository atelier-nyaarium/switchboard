package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.kindOf
import com.atelier_nyaarium.switchboard.assistant.reached
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class AutomationWalkVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("automation-walk/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun theWalkReachesWhatTheGatewaysWalkReaches() {
		val cases = vectors["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val automation = wireJson.decodeFromJsonElement(Automation.serializer(), o["automation"]!!)
			val expected = o["reached"]!!.jsonArray.map { row ->
				row.jsonObject["path"]!!.jsonPrimitive.content to row.jsonObject["kind"]!!.jsonPrimitive.content
			}

			val functions = o["functions"]?.jsonObject?.mapValues { (_, fn) ->
				wireJson.decodeFromJsonElement(AutomationFunction.serializer(), fn)
			}
			val walked = if (functions == null) {
				reached(automation).map { it.path to kindOf(it.action) }
			} else {
				reached(automation) { id -> functions[id] }.map { it.path to it.kind }
			}

			assertEquals(name, expected, walked)
		}
	}
}
