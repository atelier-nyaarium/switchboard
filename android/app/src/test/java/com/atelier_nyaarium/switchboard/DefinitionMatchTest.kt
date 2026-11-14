package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SHIPPED_DEVICE_DEFINITION_MATCHES
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class DefinitionMatchTest {
	private val vectors: JsonObject =
		wireJson.parseToJsonElement(
			javaClass.classLoader?.getResourceAsStream("definition-match/vectors.json")?.bufferedReader()?.use { it.readText() }
				?: error("missing definition-match vectors"),
		).jsonObject

	@Test
	fun replaysTheSharedDefinitionVectors() {
		for (row in vectors["cases"]!!.jsonArray.map { it.jsonObject }) {
			val advert = row["advert"]!!.jsonObject
			val parsed = Advert(
				name = advert["name"]?.jsonPrimitive?.content,
				data = advert["data"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
				services = advert["services"]!!.jsonArray.map { it.jsonPrimitive.content },
			)
			val expected = row["definition"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
			val matched = SHIPPED_DEVICE_DEFINITION_MATCHES.singleOrNull { definitionMatches(it, parsed) }?.key
			assertEquals(row["case"]!!.jsonPrimitive.content, expected, matched)
			val identified = row["identifies"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
			val bound = SHIPPED_DEVICE_DEFINITION_MATCHES.singleOrNull { definitionIdentifies(it, parsed) }?.key
			assertEquals(row["case"]!!.jsonPrimitive.content, identified, bound)
		}
	}
}
