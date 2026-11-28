package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.FitAnswer
import com.atelier_nyaarium.switchboard.assistant.WrongValue
import com.atelier_nyaarium.switchboard.assistant.fitOf
import com.atelier_nyaarium.switchboard.assistant.triggerGiven
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.GivenType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import org.junit.Assert.assertEquals
import org.junit.Test

class FunctionFitVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("automation-fit/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun strings(element: JsonElement?): List<String> =
		element?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()

	private fun givenType(wire: String): GivenType = GivenType.entries.first { it.wire == wire }

	@Test
	fun theFitAnswersWhatTheGatewaysFitAnswers() {
		val cases = vectors["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val given = o["given"]!!.jsonObject
			val params = o["params"]!!.jsonArray.map {
				FunctionParam(it.jsonObject["name"]!!.jsonPrimitive.content, it.jsonObject["type"]!!.jsonPrimitive.content)
			}
			val reads = o["reads"]!!.jsonObject.let { FunctionReads(strings(it["names"]), strings(it["eventFields"])) }
			val values = o["args"]!!.jsonObject.mapValues { it.value.jsonPrimitive }
			val expect = o["expect"]!!.jsonObject
			val expected = FitAnswer(
				fits = expect["fits"]!!.jsonPrimitive.boolean,
				hidden = expect["hidden"]!!.jsonPrimitive.boolean,
				requires = strings(expect["requires"]),
				unset = strings(expect["unset"]),
				wrong = expect["wrong"]!!.jsonArray.map {
					val w = it.jsonObject
					WrongValue(w["name"]!!.jsonPrimitive.content, w["wants"]!!.jsonPrimitive.content, givenType(w["gets"]!!.jsonPrimitive.content))
				},
			)

			val trigger = triggerGiven(
				given["kind"]!!.jsonPrimitive.content,
				fieldType = given["fieldType"]?.jsonPrimitive?.content?.let(::givenType),
				eventFields = given["eventFields"]?.let(::strings),
			)
			assertEquals(name, expected, fitOf(trigger, params, reads, values))
		}
	}
}
