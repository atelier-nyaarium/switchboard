package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class TextHolesVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("text-holes/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun thePartsMatchTheScanner() {
		val cases = vectors["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val expected =
				o["parts"]!!.jsonArray.map { part ->
					val p = part.jsonObject
					listOf(
						p["kind"]!!.jsonPrimitive.content,
						(p["text"] ?: p["source"])!!.jsonPrimitive.content,
						p["start"]!!.jsonPrimitive.int,
						p["end"]!!.jsonPrimitive.int,
						p["closed"]?.jsonPrimitive?.booleanOrNull,
					)
				}
			val actual =
				scanHoles(o["input"]!!.jsonPrimitive.content).map {
					when (it) {
						is HolePart.Text -> listOf("text", it.text, it.start, it.end, null)
						is HolePart.Hole -> listOf("hole", it.source, it.start, it.end, it.closed)
					}
				}
			assertEquals(name, expected, actual)
		}
	}
}
