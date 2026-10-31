package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneCapabilitiesVectorsTest {
	private val registry = Json.parseToJsonElement(
		javaClass.classLoader!!.getResourceAsStream("phone-capabilities/registry.json")!!.bufferedReader().readText(),
	).jsonArray

	@Test
	fun bindingsMatchTheSharedRegistry() {
		val bindings = PhoneCapabilities.bindings
		val entries = registry.map { row ->
			val fields = row.jsonObject
			fields["key"]!!.jsonPrimitive.content to fields
		}
		assertEquals(entries.map { it.first }, bindings.keys.toList())
		for ((key, fields) in entries) {
			val binding = bindings.getValue(key)
			assertEquals(fields["kind"]!!.jsonPrimitive.content, binding.kind)
			assertEquals(fields["where"]!!.jsonPrimitive.content, binding.where)
			assertEquals(fields["needs"]!!.jsonArray.map { it.jsonPrimitive.content }, binding.needs)
			assertEquals(fields["requestId"]!!.jsonPrimitive.content, binding.requestId)
			assertEquals(fields["answerId"]!!.jsonPrimitive.content, binding.answerId)
		}
	}
}
