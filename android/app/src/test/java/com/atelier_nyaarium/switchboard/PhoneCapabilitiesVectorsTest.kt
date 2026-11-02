package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneCapabilitiesVectorsTest {
	private val registryKeys = Json.parseToJsonElement(
		javaClass.classLoader!!.getResourceAsStream("phone-capabilities/registry.json")!!.bufferedReader().readText(),
	).jsonArray
		.filter { row -> row.jsonObject["where"]!!.jsonPrimitive.content != "gateway" }
		.map { row -> row.jsonObject["key"]!!.jsonPrimitive.content }

	@Test
	fun bindingOrderMatchesTheFixture() {
		assertEquals(registryKeys, PhoneCapabilities.bindings.keys.toList())
	}
}
