package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.drawsAsError
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.valuesOf
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationIssueLevel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

	/** As typed, before the editor's write. */
	private fun valueOf(o: JsonObject): JsonElement {
		o["values"]?.let { return it }
		o["valuesPastMax"]?.let { past ->
			return JsonArray((0 until Protocol.Wire.CONDITION_VALUES_MAX + past.jsonPrimitive.int).map { JsonPrimitive("v$it") })
		}
		val base = o["codes"]?.jsonArray?.let { codes -> buildString { codes.forEach { appendCodePoint(it.jsonPrimitive.int) } } }
			?: o["value"]?.jsonPrimitive?.content.orEmpty()
		val around = o["around"]?.jsonPrimitive?.content.orEmpty()
		return JsonPrimitive(around + base.repeat(o["times"]?.jsonPrimitive?.int ?: 1) + around)
	}

	@Test
	fun theSaveGateTakesWhatTheWireCarriesAndTheLinesFitWhatTheGatewayReads() {
		val rules = SourceFields(corpus["specs"]!!.jsonArray.map { specOf(it.jsonObject) })
		val cases = corpus["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val condition = AutomationCondition(o["field"]!!.jsonPrimitive.content, o["test"]!!.jsonPrimitive.content, valueOf(o))
			val trigger = TriggerDraft.Event("github", listOf(condition))
			val offer = tellOnlyOffer()
			val draft = AutomationDraft("a", trigger, listOf(StepDraft.Do("tell", toldDraft("now"))), enabled = true, revision = 0L, EditContext(offer, emptyList()))
			val fitted = fittingAutomation(draft, offer)?.trigger as? AutomationTrigger.Event
			val fits = o["fits"]!!.jsonPrimitive.boolean
			val issue = rules.issueOf(condition)
			assertEquals(name, o["parses"]?.jsonPrimitive?.boolean ?: true, fitted != null)
			assertEquals(name, fits, rules.fits(condition))
			assertEquals(name, o["warning"]?.jsonPrimitive?.boolean ?: false, issue?.level == AutomationIssueLevel.WARNING)
			// A line, unless the value is blank.
			assertEquals(name, !fits && valuesOf(condition).isNotEmpty(), issue?.let { drawsAsError(it.level) } == true)
			if (fits) o["canonical"]?.let { assertEquals(name, it, fitted?.conditions?.single()?.value) }
		}
	}
}
