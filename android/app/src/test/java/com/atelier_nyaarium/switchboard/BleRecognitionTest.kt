package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class BleRecognitionTest {
	private val vectors: JsonObject =
		wireJson.parseToJsonElement(
			javaClass.classLoader?.getResourceAsStream("ble-recognition/vectors.json")?.bufferedReader()?.use { it.readText() }
				?: error("missing ble-recognition vectors"),
		).jsonObject

	@Test
	fun replaysTheSharedRecognitionVectors() {
		for (row in vectors["cases"]!!.jsonArray.map { it.jsonObject }) {
			val advert = row["advert"]!!.jsonObject
			val parsed = Advert(
				name = advert["name"]?.jsonPrimitive?.content,
				data = advert["data"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
				services = advert["services"]!!.jsonArray.map { it.jsonPrimitive.content },
			)
			val family = row["family"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
			assertEquals(row["case"]!!.jsonPrimitive.content, family, familyOf(parsed))
		}
	}
}
