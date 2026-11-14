package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class FieldRulesTest {
	private val vectors: JsonObject =
		wireJson.parseToJsonElement(
			javaClass.classLoader?.getResourceAsStream("field-types/vectors.json")?.bufferedReader()?.use { it.readText() }
				?: error("missing field-types vectors"),
		).jsonObject

	private fun rows(name: String) = vectors[name]!!.jsonArray.map { it.jsonObject }

	@Test
	fun replaysTheSharedNumberConversionAndRenderingVectors() {
		for (row in rows("decimal")) {
			val text = row["text"]!!.jsonPrimitive.content
			val expected = row["value"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.double }
			assertEquals(text, expected, parseDecimal(text))
		}
		for (row in rows("format")) {
			val got = formatDecimal(row["value"]!!.jsonPrimitive.double, row["decimals"]!!.jsonPrimitive.int)
			assertEquals(row["text"]!!.jsonPrimitive.content, got)
		}
		for (row in rows("roundTrip")) {
			val stored = fromDisplay(row["typed"]!!.jsonPrimitive.double, "C", "F")
			assertEquals(row["stored"]!!.jsonPrimitive.double, stored, 0.0)
			assertEquals(row["readBack"]!!.jsonPrimitive.content, formatDecimal(toDisplay(stored, "C", "F").value, 1))
		}
		for (row in rows("range")) {
			val got = inRange(row["value"]!!.jsonPrimitive.double, row["decimals"]!!.jsonPrimitive.int)
			assertEquals(row.toString(), row["inRange"]!!.jsonPrimitive.boolean, got)
		}
		for (row in rows("fields")) {
			val spec = wireJson.decodeFromJsonElement(AssistantFieldSpec.serializer(), row["spec"]!!)
			val raw = row["value"]!!.jsonPrimitive
			val value: Any = if (raw.isString) raw.content else raw.double
			val display = row["display"]?.jsonPrimitive?.content
			assertEquals(row["text"]!!.jsonPrimitive.content, formatFieldValue(spec, value, display))
		}
		val temperature = AssistantFieldSpec.Number(field = "temperature", label = "Temperature", unit = "C", decimals = 1L)
		assertEquals(formatFieldValue(temperature, 3.0, "F"), formatFieldValue(temperature, 3L, "F"))
	}
}
