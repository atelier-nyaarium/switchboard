package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.CardRow
import com.atelier_nyaarium.switchboard.assistant.ConditionPreview
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.PreviewRead
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.RunsIssue
import com.atelier_nyaarium.switchboard.assistant.Slot
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.cardsDraw
import com.atelier_nyaarium.switchboard.assistant.conditionAsk
import com.atelier_nyaarium.switchboard.assistant.conditionPreviewOf
import com.atelier_nyaarium.switchboard.assistant.draftRunsIssue
import com.atelier_nyaarium.switchboard.assistant.freshStatement
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.lastRunShown
import com.atelier_nyaarium.switchboard.assistant.lastStepLine
import com.atelier_nyaarium.switchboard.assistant.madeUnique
import com.atelier_nyaarium.switchboard.assistant.movedStep
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.pickerChoices
import com.atelier_nyaarium.switchboard.assistant.runsDraftOf
import com.atelier_nyaarium.switchboard.assistant.settingsIssue
import com.atelier_nyaarium.switchboard.assistant.shiftedSlot
import com.atelier_nyaarium.switchboard.assistant.slotOffers
import com.atelier_nyaarium.switchboard.assistant.stepOfDraft
import com.atelier_nyaarium.switchboard.assistant.treeOf
import com.atelier_nyaarium.switchboard.assistant.triggerGiven
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.StepArg
import kotlinx.serialization.json.JsonPrimitive
import com.atelier_nyaarium.switchboard.assistant.everyStep
import com.atelier_nyaarium.switchboard.assistant.pathsOf
import com.atelier_nyaarium.switchboard.assistant.replacedStep
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.freshBody
import kotlinx.serialization.json.put
import com.atelier_nyaarium.switchboard.assistant.withFunctionName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StepCardsTest {
	private val none = SourceFields(emptyList())
	private val plain = Automation(enabled = true, trigger = CROSSING, actions = listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on")))
	private val older = FN_OFFER.copy(functions = FN_OFFER.functions!!.copy(served = FN_OFFER.functions!!.served.copy(unnamed = null)))

	private fun opened(offer: com.atelier_nyaarium.switchboard.assistant.AutomationOffer = FN_OFFER, automation: Automation = plain) =
		automationDraftOf(AutomationRow("mine", 2L, automation, "Thermometer above 26 °C"), EditContext(offer, emptyList()))!!

	private fun on(key: String) = StepDraft.Do(key, plugDraft(SANDBOX_SWITCH, "on"))

	/** if "a" { b } else { c }; try "d" { } catch { e } */
	private val tree = listOf(
		StepDraft.If("a", "value > 30", listOf(on("b")), listOf(on("c"))),
		StepDraft.Try("d", emptyList(), listOf(on("e"))),
	)

	@Test
	fun ownStepsStayFlatUntilATreeNeedsAnUnnamedFunction() {
		val flat = opened()
		val withIf = flat.plusStep(Slot(null, null, 1), freshStatement("if")!!.let { (it as StepDraft.If).copy(condition = "value > 30") })
		val again = withIf.plusStep(Slot(null, null, 0), freshStatement("note")!!)

		val stays = functionSaveOf(flat, none, FN_OFFER, confirmed = false)!!
		val tree = functionSaveOf(withIf, none, FN_OFFER, confirmed = false)!!
		assertEquals(listOf(null, false), listOf(stays.function, written(stays.automation).any { it is AutomationAction.RunFunction }))
		val written = tree.function as AutomationSaveFunction.Edit
		assertEquals(listOf(withIf.newFunctionId, "", 0L), listOf(written.id, written.body.name, written.base))
		assertEquals(listOf(AutomationAction.RunFunction(function = withIf.newFunctionId!!)), written(tree.automation))
		// Minted once, and again for a fresh body.
		assertEquals(withIf.newFunctionId, again.newFunctionId)
		assertNull(withIf.freshBody().newFunctionId)
		assertEquals(withIf.newFunctionId, (functionSaveOf(again, none, FN_OFFER, false)!!.function as AutomationSaveFunction.Edit).id)
	}

	@Test
	fun aTreeWithNoNameNeedsAGatewayThatHoldsUnnamedFunctions() {
		val withIf = opened(older).plusStep(Slot(null, null, 1), StepDraft.If("if", "true", emptyList(), emptyList()))

		assertNull(functionSaveOf(withIf, none, older, confirmed = false))
		assertEquals(RunsIssue.NeedsName("if"), draftRunsIssue(withIf, none, older))
		assertEquals(null, draftRunsIssue(withIf, none, FN_OFFER))
	}

	@Test
	fun anUnnamedFunctionWritesUnderItsOwnIdOrFlattensBackWhenOnlyActionsAreLeft() {
		val body = listOf(FunctionStep.If(`when` = "value > 30", steps = listOf(plugStep("on"))))
		val unnamed = functionRow("fn-own", "", listOf("mine"), steps = body)
		val pointer = plain.copy(actions = listOf(AutomationAction.RunFunction(function = "fn-own")))
		val runs = runsDraftOf("mine", pointer, listOf(unnamed), FN_OFFER) as RunsDraft.Pointing
		val draft = opened(automation = pointer).withRuns(runs)
		val flatAgain = draft.withRuns(runs.copy(steps = listOf(on("only"))))

		val kept = functionSaveOf(draft, none, FN_OFFER, false)!!
		assertEquals(listOf(null, 3L), listOf(kept.function, kept.functionBase))
		val edited = functionSaveOf(draft.withRuns(runs.copy(steps = runs.steps + on("more"))), none, FN_OFFER, false)!!
		assertEquals(listOf("fn-own", ""), (edited.function as AutomationSaveFunction.Edit).let { listOf(it.id, it.body.name) })
		val flattened = functionSaveOf(flatAgain, none, FN_OFFER, false)!!
		// Guarded by the revision it read.
		assertEquals(listOf(null, 3L), listOf(flattened.function, flattened.functionBase))
		assertEquals(listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on")), written(flattened.automation))
	}

	@Test
	fun clearingANameKeepsItsValuesAndCopiesOneAnotherFunctionCalls() {
		val called = functionRow("too-warm", "Too warm", listOf("mine"), params = listOf(com.atelier_nyaarium.switchboard.proto.FunctionParam("lamp", "device")))
			.copy(callers = listOf("other"))
		val alone = called.copy(callers = emptyList())
		val pointer = plain.copy(actions = listOf(AutomationAction.RunFunction(function = "too-warm", values = kotlinx.serialization.json.buildJsonObject { put("lamp", JsonPrimitive(SANDBOX_SWITCH)) })))
		fun cleared(offer: com.atelier_nyaarium.switchboard.assistant.AutomationOffer) = opened(offer, pointer).withFunctionName("", offer.functions)
		val withCaller = offerOf(SANDBOX_SERVES, away = false, functions = listOf(called, functionRow("other", "Other", emptyList())))
		val own = offerOf(SANDBOX_SERVES, away = false, functions = listOf(alone))
		val olderOwn = own.copy(functions = own.functions!!.copy(served = own.functions!!.served.copy(unnamed = null)))

		assertEquals(PointMode.UNIQUE, (cleared(withCaller).runsDraft() as RunsDraft.Pointing).mode)
		val kept = cleared(own)
		assertEquals(listOf("", PointMode.SHARED), (kept.runsDraft() as RunsDraft.Pointing).let { listOf(it.name, it.mode) })
		assertEquals("", ((functionSaveOf(kept, none, own, false)!!.function as AutomationSaveFunction.Edit).body.name))
		assertEquals(RunsIssue.NameWithValues, draftRunsIssue(cleared(olderOwn), none, olderOwn))
	}

	@Test
	fun anUnnamedFunctionIsNeverPickedAndACopyOfOneStaysUnnamed() {
		val unnamed = functionRow("fn-own", "", listOf("other"))
		val named = functionRow("too-warm", "Too warm", listOf("other"))
		val pointer = plain.copy(actions = listOf(AutomationAction.RunFunction(function = "fn-own")))
		val offer = offerOf(SANDBOX_SERVES, away = false, functions = listOf(unnamed, named))
		val draft = opened(offer, pointer)

		assertEquals(listOf("too-warm"), pickerChoices(triggerGiven("crossing"), listOf(unnamed, named), null).map { it.function.id })
		assertEquals("", (draft.madeUnique(offer).runsDraft() as RunsDraft.Pointing).name)
		assertEquals("Too warm.001", (opened(offer, pointer.copy(actions = listOf(AutomationAction.RunFunction(function = "too-warm")))).madeUnique(offer).runsDraft() as RunsDraft.Pointing).name)
	}

	@Test
	fun cardsDrawBothSidesOfAnIfAndATryWithTheirAddSlotsAndLastRun() {
		val run = AutomationLastRun(
			at = 0L,
			revision = 2L,
			steps = listOf(
				AutomationLastStep("0.0", "if", outcome = "ran", side = "else"),
				AutomationLastStep("0.0.1.0", "device_set", outcome = "refused", reason = "not home"),
			),
			active = "0.1",
			running = true,
		)

		val rows = cardsDraw(tree, { null }, run, pointing = true)
		val shape = rows.map { row ->
			when (row) {
				is CardRow.Card -> "${row.depth}:${row.step.key}@${row.path}"
				is CardRow.SideLabel -> "${row.depth}:${row.side}"
				is CardRow.AddSlot -> "${row.depth}:+${row.slot.parent ?: "top"}"
			}
		}
		assertEquals(
			listOf("0:a@0", "1:b@0.0.0", "1:+a", "1:ELSE", "1:c@0.1.0", "1:+a", "0:d@1", "1:+d", "1:CATCH", "1:e@1.1.0", "1:+d", "0:+top"),
			shape,
		)
		val cards = rows.filterIsInstance<CardRow.Card>().associateBy { it.step.key }
		assertEquals("Last run: it did not hold", lastStepLine(cards.getValue("a"), running = true))
		assertEquals("Last run: failed: not home", lastStepLine(cards.getValue("c"), running = true))
		assertEquals("Running now", lastStepLine(cards.getValue("d"), running = true))
		assertNull(lastStepLine(cards.getValue("b"), running = true))
	}

	@Test
	fun aLastRunIsShownOnlyWhileTheEditorShowsWhatItRan() {
		val run = AutomationLastRun(0L, 2L, emptyList(), running = false)
		val row = AutomationRow("mine", 2L, plain, "Thermometer above 26 °C", lastRun = run)
		val draft = opened()
		val unnamed = functionRow("fn-own", "", listOf("mine"), steps = listOf(plugStep("on")))
		val pointer = plain.copy(actions = listOf(AutomationAction.RunFunction(function = "fn-own")))
		val listed = offerOf(SANDBOX_SERVES, away = false, functions = listOf(unnamed))
		val pointed = opened(listed, pointer)
		val pointedRow = row.copy(automation = pointer)
		val movedOn = offerOf(SANDBOX_SERVES, away = false, functions = listOf(unnamed.copy(revision = 4L)))

		assertEquals(run, lastRunShown(draft, draft, row, FN_OFFER.functions))
		assertEquals(run, lastRunShown(draft.copy(enabled = false), draft, row, FN_OFFER.functions))
		assertNull(lastRunShown(draft.plusStep(Slot(null, null, 1), StepDraft.Exit("x")), draft, row, FN_OFFER.functions))
		// Stored past what the editor opened.
		assertNull(lastRunShown(draft, draft, row.copy(revision = 3L), FN_OFFER.functions))
		assertEquals(run, lastRunShown(pointed, pointed, pointedRow, listed.functions))
		assertNull(lastRunShown(pointed, pointed, pointedRow, movedOn.functions))
	}

	@Test
	fun aStepMovesWithinItsOwnListAndEveryStatementWritesBackWhole() {
		assertNull(shiftedSlot(tree, "b", 1))
		val moved = movedStep(tree, "d", shiftedSlot(tree, "d", -1)!!)!!
		assertEquals(listOf("d", "a"), moved.map { it.key })

		val cards = listOf(
			StepDraft.If("i", " value > 30 ", listOf(on("x")), listOf(StepDraft.Exit("y"))),
			StepDraft.Try("t", listOf(StepDraft.Wait("w", "2.5")), listOf(StepDraft.Note("n", "it failed"))),
		)
		val written = cards.map { stepOfDraft(it, FN_OFFER)!! }

		assertEquals(" value > 30 ", (written[0] as FunctionStep.If).`when`)
		assertEquals(
			FunctionStep.Try(steps = listOf(FunctionStep.Wait(StepArg.Literal(JsonPrimitive(2.5)))), catch = listOf(FunctionStep.Note("it failed"))),
			written[1],
		)
		assertEquals(written, written.map { stepOfDraft(treeOf(it, FN_OFFER), FN_OFFER) })
		for (kind in listOf("if", "try", "wait", "exit", "note")) assertTrue(freshStatement(kind) != null)
	}

	@Test
	fun aConditionIsAskedWithWhatARunSetsAndReadsAsTheGatewaySays() {
		val kept = StepDraft.Kept("k", FunctionStep.Let("total", StepArg.Literal(JsonPrimitive(1))))
		val ask = conditionAsk(CROSSING, " value > 30 ", null, tree + kept)!!
		fun said(condition: AutomationPreviewCondition) =
			PreviewRead(ConsoleAutomationPreviewResult(matched = 0L, of = 0L, matches = emptyList(), condition = condition))

		// As typed, so its offsets land.
		assertEquals(listOf(" value > 30 ", listOf("total", "e")), listOf(ask.condition, ask.runNames))
		assertNull(conditionAsk(CROSSING, "  ", null, tree))
		assertNull(conditionAsk(null, "true", null, tree))
		assertEquals(ConditionPreview.Holds(true), conditionPreviewOf("true", true, said(AutomationPreviewCondition(holds = true))))
		assertEquals(ConditionPreview.CannotTell("it reads a value set while it runs"), conditionPreviewOf("total", true, said(AutomationPreviewCondition(unread = "it reads a value set while it runs"))))
		assertEquals(ConditionPreview.Plain, conditionPreviewOf("", true, said(AutomationPreviewCondition(holds = true))))
		assertEquals(ConditionPreview.Unread, conditionPreviewOf("true", true, PreviewRead(failed = true)))
	}

	@Test
	fun addSlotsStopAtTheFlatCapOnlyWhereStepsMustStayPlain() {
		val full = opened(older).let { draft ->
			(2..8).fold(draft) { held, _ -> held.plusAction(plugDraft(SANDBOX_SWITCH, "off")) }
		}
		val top = CardRow.AddSlot(Slot(null, null, full.steps.size), 0, full = false)

		assertEquals(8, full.steps.size)
		assertTrue(slotOffers(full, older, top).empty)
		val served = slotOffers(full, FN_OFFER, top)
		assertTrue(served.actions.isNotEmpty())
		assertEquals(listOf("if", "try", "wait", "exit", "note"), served.statements.map { it.kind })
		assertTrue(slotOffers(full, FN_OFFER, top.copy(full = true)).empty)
	}

	@Test
	fun whatCardsDoNotDrawIsWrittenBackByteForByteWhateverItsSiblingsDo() {
		val raw = javaClass.classLoader!!.getResourceAsStream("protocol/function-tree-future-kind.json")!!.bufferedReader().readText()
		val stored = wireJson.parseToJsonElement(raw).jsonObject["steps"]!!.jsonArray
		val function = wireJson.decodeFromString(AutomationFunction.serializer(), raw)
		var next = 0
		val cards = written(function).map { treeOf(it, FN_OFFER) { "k${next++}" } }
		val inner = everyStep(cards).filterIsInstance<StepDraft.If>().last().key
		val edited = replacedStep(cards, inner) { (it as StepDraft.If).copy(condition = "failed && ready") }

		fun storedAt(steps: JsonArray, path: List<Int>): JsonElement {
			val step = steps[path[0]].jsonObject
			if (path.size == 1) return step
			val side = when (step["kind"]!!.jsonPrimitive.content to path[1]) {
				"if" to 0, "try" to 0 -> "steps"
				"if" to 1 -> "else"
				else -> "catch"
			}
			return storedAt(step[side]!!.jsonArray, path.drop(2))
		}
		fun keptBytes(tree: List<StepDraft>): Map<String, String> {
			val paths = pathsOf(tree)
			return everyStep(tree).filterIsInstance<StepDraft.Kept>().associate { kept ->
				paths.getValue(kept.key) to wireJson.encodeToString(FunctionStep.serializer(), stepOfDraft(kept, FN_OFFER)!!)
			}
		}

		val kept = keptBytes(cards)
		// Unknown in an If's else, at the top, and a throw and a let in a catch's If.
		assertEquals(setOf("1", "0.0.0.1.0.0.1", "0.0.0.1.0.0.2", "0.0.0.1.0.1.0"), kept.keys)
		for ((path, bytes) in kept) assertEquals(path, storedAt(stored, path.split(".").map { it.toInt() }).toString(), bytes)
		assertEquals(kept, keptBytes(edited))
	}

	@Test
	fun keepTryingAndAnEventsCoolDownSurviveTheDraft() {
		val event = Automation(
			enabled = true,
			trigger = AutomationTrigger.Event("github", emptyList(), coolDownSec = 600L),
			actions = listOf(AutomationAction.TellAssistant("now")),
			keepTryingMin = 25L,
		)
		val draft = automationDraftOf(AutomationRow("mine", 2L, event, "A GitHub event"), EditContext(FN_OFFER, emptyList()))!!

		assertEquals(event, draft.toAutomation(FN_OFFER))
		assertEquals("Keep trying is 1 to 60 minutes", settingsIssue(draft.copy(keepTryingMin = "90")))
		assertNull(draft.copy(keepTryingMin = "90").toAutomation(FN_OFFER))
		assertEquals(null, draft.copy(keepTryingMin = "").toAutomation(FN_OFFER)?.keepTryingMin)
		assertEquals(null, (draft.withEventCoolDown("").toAutomation(FN_OFFER)?.trigger as AutomationTrigger.Event).coolDownSec)
	}
}
