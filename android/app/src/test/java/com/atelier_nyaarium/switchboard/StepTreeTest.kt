package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.STEPS_DEPTH
import com.atelier_nyaarium.switchboard.assistant.STEPS_PER_LIST
import com.atelier_nyaarium.switchboard.assistant.STEPS_TOTAL
import com.atelier_nyaarium.switchboard.assistant.Side
import com.atelier_nyaarium.switchboard.assistant.Slot
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.byPath
import com.atelier_nyaarium.switchboard.assistant.everyStep
import com.atelier_nyaarium.switchboard.assistant.findStep
import com.atelier_nyaarium.switchboard.assistant.insertedStep
import com.atelier_nyaarium.switchboard.assistant.keyAt
import com.atelier_nyaarium.switchboard.assistant.movedStep
import com.atelier_nyaarium.switchboard.assistant.pathsOf
import com.atelier_nyaarium.switchboard.assistant.removedStep
import com.atelier_nyaarium.switchboard.assistant.replacedStep
import com.atelier_nyaarium.switchboard.assistant.stepPaths
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StepTreeTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("step-path/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun exit(key: String) = StepDraft.Exit(key)

	/** if "a" { b, c } else { d }; try "e" { f } catch { }; g */
	private val tree = listOf(
		StepDraft.If("a", "true", listOf(exit("b"), exit("c")), listOf(exit("d"))),
		StepDraft.Try("e", listOf(exit("f")), emptyList()),
		exit("g"),
	)

	@Test
	fun aStoredBodyHasTheGatewaysPathsAndOrder() {
		for (case in vectors["cases"]!!.jsonArray) {
			val o = case.jsonObject
			val steps = wireJson.decodeFromJsonElement(ListSerializer(FunctionStep.serializer()), o["steps"]!!)
			val paths = o["paths"]!!.jsonArray.map { it.jsonPrimitive.content }
			assertEquals(o["name"]!!.jsonPrimitive.content, paths, stepPaths(steps))
		}
		for (case in vectors["order"]!!.jsonArray) {
			val o = case.jsonObject
			val given = o["given"]!!.jsonArray.map { it.jsonPrimitive.content }
			assertEquals(o["sorted"]!!.jsonArray.map { it.jsonPrimitive.content }, given.sortedWith(byPath))
		}
	}

	@Test
	fun aDraftsPathsAreDerivedFromWhereEachKeySits() {
		val paths = pathsOf(tree)

		assertEquals(
			mapOf("a" to "0", "b" to "0.0.0", "c" to "0.0.1", "d" to "0.1.0", "e" to "1", "f" to "1.0.0", "g" to "2"),
			paths,
		)
		assertEquals("d", keyAt(tree, "0.1.0"))
		assertNull(keyAt(tree, "0.1.1"))
	}

	@Test
	fun anEditByKeyKeepsEveryOtherKeyWhereItWas() {
		val added = insertedStep(tree, Slot("e", Side.Catch, 0), exit("h"))!!
		val renamed = replacedStep(added, "a") { (it as StepDraft.If).copy(condition = "false") }
		val removed = removedStep(renamed, "c")
		val moved = movedStep(removed, "g", Slot("a", Side.Else, 0))!!

		assertEquals(
			mapOf("a" to "0", "b" to "0.0.0", "g" to "0.1.0", "d" to "0.1.1", "e" to "1", "f" to "1.0.0", "h" to "1.1.0"),
			pathsOf(moved),
		)
		assertEquals("false", (findStep(moved, "a") as StepDraft.If).condition)
	}

	@Test
	fun aStepCannotMoveIntoItselfOrAGoneSlot() {
		assertNull(movedStep(tree, "a", Slot("b", Side.Then, 0)))
		assertNull(movedStep(tree, "e", Slot("e", Side.Body, 0)))
		assertNull(insertedStep(tree, Slot("gone", Side.Then, 0), exit("h")))
	}

	@Test
	fun eachCapRefusesTheStepPastIt() {
		val full = List(STEPS_PER_LIST) { exit("x$it") }
		// As deep as a body may go: the leaf at the last level.
		val deep = (1 until STEPS_DEPTH).fold(listOf<StepDraft>(exit("leaf"))) { inner, level -> listOf(StepDraft.Try("t$level", inner, emptyList())) }
		val wide = List(STEPS_PER_LIST) { at -> StepDraft.Try("w$at", List(3) { exit("w$at.$it") }, emptyList()) }

		assertNull(insertedStep(full, Slot(null, null, 0), exit("over")))
		assertEquals(true, insertedStep(deep, Slot("t1", Side.Body, 0), exit("beside")) != null)
		assertNull(insertedStep(deep, Slot("t1", Side.Body, 0), StepDraft.Try("t0", listOf(exit("deeper")), emptyList())))
		assertEquals(STEPS_TOTAL, everyStep(wide).size)
		assertNull(insertedStep(wide, Slot("w0", Side.Catch, 0), exit("over")))
	}
}
