package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** The vectors src/__tests__/content-hash-vectors.test.ts runs against Lexicon's own hash. */
class ContentHashVectorsTest {
	@Test
	fun `the twin hashes every shared vector as Lexicon does`() {
		val vectors = Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("content-hash/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["cases"]!!.jsonArray
		for (vector in vectors) {
			val text = vector.jsonObject["text"]!!.jsonPrimitive.content
			assertEquals(text, vector.jsonObject["hash"]!!.jsonPrimitive.content, hashContent(text))
		}
	}
}
