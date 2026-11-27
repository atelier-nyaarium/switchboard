package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.UnfollowedCall
import com.atelier_nyaarium.switchboard.assistant.WalkAction
import com.atelier_nyaarium.switchboard.assistant.WalkEntry
import com.atelier_nyaarium.switchboard.assistant.WalkStep
import com.atelier_nyaarium.switchboard.assistant.kindOf
import com.atelier_nyaarium.switchboard.assistant.reached
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class AutomationWalkVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("automation-walk/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private data class Row(val reach: String, val path: String, val kind: String, val index: Int?, val reason: String?)

	private fun rowOf(entry: WalkEntry): Row = when (entry) {
		is WalkAction -> Row("action", entry.path, kindOf(entry.action), entry.index, null)
		is WalkStep -> Row(
			"step",
			entry.path,
			when (val step = entry.step) {
				is FunctionStep.Do -> step.action
				is FunctionStep.If -> "if"
				is FunctionStep.Switch -> "switch"
				is FunctionStep.Try -> "try"
				is FunctionStep.Parallel -> "parallel"
				is FunctionStep.Start -> "start"
				is FunctionStep.Await -> "await"
				is FunctionStep.Exit -> "exit"
				is FunctionStep.Throw -> "throw"
				is FunctionStep.Let -> "let"
				is FunctionStep.Wait -> "wait"
				is FunctionStep.Note -> "note"
				is FunctionStep.Unparsed -> "unparsed"
				is FunctionStep.Call -> "call"
				is FunctionStep.Unknown -> step.kind
			},
			entry.index,
			null,
		)
		is UnfollowedCall -> Row("unfollowedCall", entry.path, kindOf(entry.call), null, entry.reason.wire)
	}

	@Test
	fun theWalkReachesWhatTheGatewaysWalkReaches() {
		val cases = vectors["cases"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val automation = wireJson.decodeFromJsonElement(Automation.serializer(), o["automation"]!!)
			val expected = o["reached"]!!.jsonArray.map { row ->
				val held = row.jsonObject
				Row(
					held["reach"]!!.jsonPrimitive.content,
					held["path"]!!.jsonPrimitive.content,
					held["kind"]!!.jsonPrimitive.content,
					held["index"]?.jsonPrimitive?.intOrNull,
					held["reason"]?.jsonPrimitive?.contentOrNull,
				)
			}

			val functions = o["functions"]?.jsonObject?.mapValues { (_, fn) ->
				wireJson.decodeFromJsonElement(AutomationFunction.serializer(), fn)
			}
			val walked = if (functions == null) reached(automation) else reached(automation) { id -> functions[id] }

			assertEquals(name, expected, walked.map(::rowOf))
		}
	}
}
