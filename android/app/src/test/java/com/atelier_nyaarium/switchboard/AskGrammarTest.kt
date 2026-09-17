package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun nodesOf(array: JsonArray): List<AskNode> =
	array.map { element ->
		val node = element.jsonObject
		AskNode(
			name = node["name"]!!.jsonPrimitive.content,
			kind = node["kind"]!!.jsonPrimitive.content,
			symbolId = node["symbolId"]!!.jsonPrimitive.content,
			questions = node["questions"]!!.jsonArray.map { it.jsonPrimitive.content },
			children = node["children"]?.jsonArray?.let(::nodesOf).orEmpty(),
		)
	}

private fun pairsOf(array: JsonArray): List<Pair<String, List<String>>> =
	array.map { element ->
		val pair = element.jsonObject
		pair["symbolId"]!!.jsonPrimitive.content to pair["questions"]!!.jsonArray.map { it.jsonPrimitive.content }
	}

class AskGrammarTest {
	private val cases =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("ask-grammar/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

	@Test
	fun `the render writes the lines the corpus pins`() {
		assertTrue(cases.isNotEmpty())
		for (case in cases) {
			val name = case["name"]!!.jsonPrimitive.content
			val lines = case["lines"]!!.jsonArray.map { it.jsonPrimitive.content }

			assertEquals(name, lines, askTreeLines(nodesOf(case["nodes"]!!.jsonArray)))
		}
	}

	@Test
	fun `the parse reads back the pairs the corpus pins`() {
		for (case in cases) {
			val name = case["name"]!!.jsonPrimitive.content
			val text = case["lines"]!!.jsonArray.joinToString("\n") { it.jsonPrimitive.content }
			val expected = pairsOf(case["pairs"]!!.jsonArray)

			assertEquals(name, expected, askTreePairs(text))
		}
	}

	@Test
	fun `a rendered tree parses back to the pairs its nodes name`() {
		for (case in cases) {
			val name = case["name"]!!.jsonPrimitive.content
			val nodes = nodesOf(case["nodes"]!!.jsonArray)

			assertEquals(name, pairsOf(case["pairs"]!!.jsonArray), askTreePairs(askTreeLines(nodes).joinToString("\n")))
		}
	}

	@Test
	fun `prose around the tree names nothing`() {
		val prose = listOf(
			"Record Lexicon knowledge for `A` in `src/a.ts`: 1 answer across 1 symbol.",
			"",
			"How:",
			"- One `record_answer` per question, citing at least one fact beyond the declaration.",
			"- Members before their container: the container's answers cite its members' answer ids.",
			"",
			"Tree:",
		)

		assertEquals(emptyList<Pair<String, List<String>>>(), askTreePairs(prose.joinToString("\n")))
	}

	@Test
	fun `a line naming no known question names nothing`() {
		val known = "- `A` class: describe. `lexicon typescript src/a.ts A`"
		val unknown = "- `A` class: invent. `lexicon typescript src/a.ts A`"

		assertEquals(1, askTreePairs(known).size)
		assertEquals(emptyList<Pair<String, List<String>>>(), askTreePairs(unknown))
	}
}
