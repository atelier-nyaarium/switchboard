package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.trimRuleValue
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantRuleVectorsTest {
	private val corpus =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("assistant-rules/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun specOf(o: JsonObject): AssistantFieldSpec {
		val field = o["field"]!!.jsonPrimitive.content
		val label = o["label"]!!.jsonPrimitive.content
		if (o["kind"]!!.jsonPrimitive.content != "enumeration") return AssistantFieldSpec.Text(field, label)
		val options = o["options"]!!.jsonArray.map {
			val option = it.jsonObject
			AssistantFieldOption(option["value"]!!.jsonPrimitive.content, option["label"]!!.jsonPrimitive.content)
		}
		return AssistantFieldSpec.Enumeration(field, label, options)
	}

	private fun valueOf(o: JsonObject): String {
		val base = o["codes"]?.jsonArray?.let { codes -> buildString { codes.forEach { appendCodePoint(it.jsonPrimitive.int) } } }
			?: o["value"]?.jsonPrimitive?.content.orEmpty()
		val around = o["around"]?.jsonPrimitive?.content.orEmpty()
		return around + base.repeat(o["times"]?.jsonPrimitive?.int ?: 1) + around
	}

	@Test
	fun theSaveGateFitsWhatTheGatewayParseAccepts() {
		val rules = SourceFields(corpus["specs"]!!.jsonArray.map { specOf(it.jsonObject) })
		val cases = corpus["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val condition = AutomationCondition(o["field"]!!.jsonPrimitive.content, o["test"]!!.jsonPrimitive.content, valueOf(o))
			val trigger = TriggerDraft.Event("github", listOf(condition))
			val draft = AutomationDraft("a", trigger, listOf(toldDraft("now")), enabled = true, revision = 0L)
			val fitted = fittingAutomation(draft, rules)?.trigger as? AutomationTrigger.Event
			assertEquals(name, o["fits"]!!.jsonPrimitive.boolean, fitted != null)
			o["canonical"]?.let { assertEquals(name, it.jsonPrimitive.content, fitted?.conditions?.single()?.value) }
			// A blocked Save says why, unless the value is blank.
			val says = rules.issueOf(condition) != null
			assertEquals(name, fitted == null && trimRuleValue(condition.value).isNotEmpty(), says)
		}
	}
}
