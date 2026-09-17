package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

/** The corpus the plugin writes from its own highlighter, read here by the paint model. */
class CodeSpansVectorsTest {
	private val corpus =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("code-spans/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun `the token order is the plugin's`() {
		assertEquals(corpus["tokens"]!!.jsonArray.map { it.jsonPrimitive.content }, CodeToken.entries.map { it.wire })
	}

	@Test
	fun `every vector paints to the triples the plugin wrote`() {
		for (vector in corpus["cases"]!!.jsonArray) {
			val case = vector.jsonObject
			val name = case["name"]!!.jsonPrimitive.content
			val spans = (case["lines"] as? JsonArray)?.map { line -> line.jsonArray.map { it.jsonPrimitive.long } }
			val painted = paintSource(case["text"]!!.jsonPrimitive.content, spans, 1)

			if (spans == null) {
				assertEquals(name, JsonNull, case["lines"])
				assertEquals(name, emptyList<PaintRun>(), painted.flatMap { it.runs })
				continue
			}
			assertEquals(name, spans.size, painted.size)
			for ((index, line) in painted.withIndex()) {
				assertEquals("$name line $index", spans[index], triplesOf(line))
			}
		}
	}

	/** Back to the wire's form, so a mismatch names the triple rather than a run object. */
	private fun triplesOf(line: PaintedLine): List<Long> =
		line.runs.flatMap { listOf(it.start.toLong(), (it.end - it.start).toLong(), it.token.ordinal.toLong()) }
}
