package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.CaseDraft
import com.atelier_nyaarium.switchboard.assistant.STEPS_PER_LIST
import com.atelier_nyaarium.switchboard.assistant.STEPS_TOTAL
import com.atelier_nyaarium.switchboard.assistant.Side
import com.atelier_nyaarium.switchboard.assistant.Slot
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.byPath
import com.atelier_nyaarium.switchboard.assistant.chainOf
import com.atelier_nyaarium.switchboard.assistant.everyStep
import com.atelier_nyaarium.switchboard.assistant.findStep
import com.atelier_nyaarium.switchboard.assistant.insertedStep
import com.atelier_nyaarium.switchboard.assistant.keyAt
import com.atelier_nyaarium.switchboard.assistant.linkKeys
import com.atelier_nyaarium.switchboard.assistant.mayMove
import com.atelier_nyaarium.switchboard.assistant.moveChoices
import com.atelier_nyaarium.switchboard.assistant.movedStep
import com.atelier_nyaarium.switchboard.assistant.pathsOf
import com.atelier_nyaarium.switchboard.assistant.removedStep
import com.atelier_nyaarium.switchboard.assistant.replacedStep
import com.atelier_nyaarium.switchboard.assistant.stepOfDraft
import com.atelier_nyaarium.switchboard.assistant.stepPaths
import com.atelier_nyaarium.switchboard.assistant.treeOf
import com.atelier_nyaarium.switchboard.assistant.withElseIf
import com.atelier_nyaarium.switchboard.assistant.withoutLink
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
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

	private fun ret(key: String) = StepDraft.Return(key)

	/** if "a" { b, c } else { d }; try "e" { f } catch { }; g */
	private val tree = listOf(
		StepDraft.If("a", "true", listOf(ret("b"), ret("c")), listOf(ret("d"))),
		StepDraft.Try("e", listOf(ret("f")), emptyList()),
		ret("g"),
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
		val added = insertedStep(tree, Slot("e", Side.Catch, 0), ret("h"))!!
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
	fun aCardMovesIntoTheSidesOfTheCardAboveOrOutOfTheCardDrawingIt() {
		val chained = listOf(
			StepDraft.If("a", "v > 3", listOf(ret("b")), listOf(StepDraft.If("c", "v > 2", listOf(ret("x")), listOf(ret("e"))))),
			StepDraft.Switch(
				"s",
				"event.kind",
				listOf(CaseDraft("k0", listOf("mention"), emptyList()), CaseDraft("k1", emptyList(), emptyList()), CaseDraft("k2", emptyList(), emptyList())),
				listOf(ret("y")),
			),
			ret("g"),
		)
		val kinds = listOf(AssistantFieldOption("mention", "Mention"))
		fun choices(steps: List<StepDraft>, key: String) = moveChoices(steps, key, FN_OFFER) { kinds.takeIf { _ -> it == "event.kind" } }
		fun labels(steps: List<StepDraft>, key: String) = choices(steps, key).map { it.label }
		fun moved(steps: List<StepDraft>, key: String, label: String) =
			pathsOf(movedStep(steps, key, choices(steps, key).single { it.label == label }.slot)!!)[key]

		assertEquals(listOf("Move up", "Into Try above", "Into Catch above"), labels(tree, "g"))
		assertEquals(listOf("Move down", "Out of If"), labels(tree, "b"))
		assertEquals(listOf("Move up", "Move down", "Into If above", "Into Else if above", "Into Else above"), labels(chained, "s"))
		assertEquals(
			listOf("Move up", "Into Case Mention above", "Into Case 1 above", "Into Case 2 above", "Into Default above"),
			labels(chained, "g"),
		)
		assertEquals(listOf(false, true), listOf(mayMove(listOf(ret("lone")), "lone"), mayMove(chained, "x")))
		// Leaves the whole chain.
		assertEquals(listOf("Out of If"), labels(chained, "x"))
		assertEquals("1", moved(chained, "x", "Out of If"))
		assertEquals("0.1.0.1.1", moved(chained, "s", "Into Else above"))
		assertEquals("1.3.1", moved(chained, "g", "Into Default above"))
		assertEquals("1.1.0", moved(tree, "g", "Into Catch above"))
		val longer = listOf(
			StepDraft.If("a", "v > 3", emptyList(), listOf(StepDraft.If("c", "v > 2", emptyList(), listOf(StepDraft.If("d", "v > 1", emptyList(), emptyList()))))),
			ret("g"),
		)
		assertEquals(
			listOf("Move up", "Into If above", "Into Else if 1 above", "Into Else if 2 above", "Into Else above"),
			labels(longer, "g"),
		)
	}

	@Test
	fun noMoveTurnsACardIntoALinkOrALinkIntoACard() {
		val trailing = listOf(StepDraft.If("a", "v > 3", emptyList(), emptyList()), StepDraft.If("x", "v > 2", listOf(ret("t")), emptyList()))
		val beside = listOf(StepDraft.If("a", "v > 3", emptyList(), listOf(StepDraft.If("b", "v > 2", emptyList(), emptyList()), ret("x"))))

		assertEquals(setOf<String>(), linkKeys(trailing))
		// Would make x a link.
		assertEquals(listOf("Move up", "Into If above"), moveChoices(trailing, "x", FN_OFFER) { null }.map { it.label })
		// Each other move leaves b alone.
		assertEquals(listOf("Move up"), moveChoices(beside, "x", FN_OFFER) { null }.map { it.label })
	}

	@Test
	fun aStepCannotMoveIntoItselfOrAGoneSlot() {
		assertNull(movedStep(tree, "a", Slot("b", Side.Then, 0)))
		assertNull(movedStep(tree, "e", Slot("e", Side.Body, 0)))
		assertNull(insertedStep(tree, Slot("gone", Side.Then, 0), ret("h")))
	}

	@Test
	fun eachCapRefusesTheStepPastIt() {
		val full = List(minOf(STEPS_PER_LIST, STEPS_TOTAL)) { ret("x$it") }
		val wide = List(STEPS_TOTAL / 4) { at -> StepDraft.Try("w$at", List(3) { ret("w$at.$it") }, emptyList()) }

		assertNull(insertedStep(full, Slot(null, null, 0), ret("over")))
		assertEquals(STEPS_TOTAL, everyStep(wide).size)
		assertNull(insertedStep(wide, Slot("w0", Side.Catch, 0), ret("over")))
	}

	/** Gateway-written bodies. */
	private val stored = listOf(
		"""{"kind":"switch","subject":"event.reason","cases":[{"values":["mention","Assign"],"steps":[{"kind":"return"}]},""" +
			"""{"values":[],"steps":[]}],"default":[{"kind":"comment","text":"b"}]}""",
		"""{"kind":"switch","subject":"","cases":[]}""",
		"""{"kind":"if","condition":"a","steps":[{"kind":"return"}],"else":[{"kind":"if","condition":"b","else":""" +
			"""[{"kind":"if","condition":"c","steps":[{"kind":"comment","text":"c"}],"else":[{"kind":"return"}]}]}]}""",
	)

	private fun written(step: StepDraft) = wireJson.encodeToString(FunctionStep.serializer(), stepOfDraft(step, FN_OFFER, calleeParams = listed(FN_OFFER))!!)

	@Test
	fun aSwitchAndAnElseIfChainWriteBackByteForByte() {
		val trees = stored.map { treeOf(wireJson.decodeFromString(FunctionStep.serializer(), it), FN_OFFER) }

		assertEquals(stored, trees.map(::written))
		val switch = trees[0] as StepDraft.Switch
		assertEquals(listOf(listOf("mention", "Assign"), emptyList()), switch.cases.map { it.values })
		assertEquals(3, (switch.cases.map { it.key } + switch.key).toSet().size)
		val chain = chainOf(trees[2] as StepDraft.If)
		val edited = replacedStep(listOf(trees[2]), chain[1].key) { (it as StepDraft.If).copy(condition = "b2") }.single()
		assertEquals(stored[2].replace("\"condition\":\"b\"", "\"condition\":\"b2\""), written(edited))
		assertEquals(listOf("0", "0.0.0", "0.1.0", "0.1.0.1.0", "0.1.0.1.0.0.0", "0.1.0.1.0.1.0"), pathsOf(listOf(trees[2])).values.toList())
	}

	@Test
	fun aFreshLinkTakesTheLastElseAndCapsStillRefuse() {
		val chain = listOf(StepDraft.If("a", "x", listOf(ret("b")), listOf(ret("c"), ret("d"))))
		val longer = withElseIf(chain, "a")!!
		val links = chainOf(longer.single() as StepDraft.If)

		assertEquals(listOf("a"), links.take(1).map { it.key })
		assertEquals(listOf("c", "d"), links[1].elseSteps.map { it.key })
		assertEquals(chain, withoutLink(longer, links[1].key))
		val wide = List(STEPS_TOTAL / 4) { at -> StepDraft.If("w$at", "x", List(3) { ret("w$at.$it") }, emptyList()) }
		assertEquals(STEPS_TOTAL, everyStep(wide).size)
		assertNull(withElseIf(wide, "w0"))
	}
}
