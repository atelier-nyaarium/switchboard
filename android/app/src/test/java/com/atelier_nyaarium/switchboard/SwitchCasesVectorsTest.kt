package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.SwitchIssue
import com.atelier_nyaarium.switchboard.assistant.caseKey
import com.atelier_nyaarium.switchboard.assistant.choiceFieldOf
import com.atelier_nyaarium.switchboard.assistant.switchIssues
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class SwitchCasesVectorsTest {
	private val corpus =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("switch-cases/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun strings(o: JsonObject, key: String): List<String> = o[key]!!.jsonArray.map { it.jsonPrimitive.content }

	private fun wire(issue: SwitchIssue): Map<String, Any?> = mapOf(
		"level" to issue.level.wire,
		"why" to issue.why.wire,
		"case" to issue.case,
		"chip" to issue.chip,
		"value" to issue.value,
	)

	@Test
	fun theComparisonTheSubjectAndTheIssuesAreTheGateways() {
		for (case in corpus["keys"]!!.jsonArray) {
			val o = case.jsonObject
			assertEquals(o.toString(), o["key"]!!.jsonPrimitive.content, caseKey(o["value"]!!.jsonPrimitive.content))
		}
		for (case in corpus["choiceFields"]!!.jsonArray) {
			val o = case.jsonObject
			val field = o["field"]!!.takeUnless { it is JsonNull }?.jsonPrimitive?.content
			assertEquals(o.toString(), field, choiceFieldOf(o["subject"]!!.jsonPrimitive.content))
		}
		for (case in corpus["issues"]!!.jsonArray) {
			val o = case.jsonObject
			val cases = o["cases"]!!.jsonArray.map { strings(it.jsonObject, "values") }
			val choices = o["choices"]!!.takeUnless { it is JsonNull }?.jsonArray?.map { it.jsonPrimitive.content }
			val expected = o["issues"]!!.jsonArray.map { issue ->
				val held = issue.jsonObject
				mapOf(
					"level" to held["level"]!!.jsonPrimitive.content,
					"why" to held["why"]!!.jsonPrimitive.content,
					"case" to held["case"]!!.jsonPrimitive.int,
					"chip" to held["chip"]?.jsonPrimitive?.int,
					"value" to held["value"]?.jsonPrimitive?.content,
				)
			}
			assertEquals(o["name"]!!.jsonPrimitive.content, expected, switchIssues(cases, choices).map(::wire))
		}
	}
}
