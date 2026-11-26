package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.CheckRead
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.SaidAt
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.checkAfter
import com.atelier_nyaarium.switchboard.assistant.checkedFor
import com.atelier_nyaarium.switchboard.assistant.movedFor
import com.atelier_nyaarium.switchboard.assistant.pointedTo
import com.atelier_nyaarium.switchboard.assistant.checkedReads
import com.atelier_nyaarium.switchboard.assistant.checkSaidOf
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.reloadedFunction
import com.atelier_nyaarium.switchboard.assistant.saveAllowedAfterCheck
import com.atelier_nyaarium.switchboard.assistant.stepOfDraft
import com.atelier_nyaarium.switchboard.assistant.valuesByName
import com.atelier_nyaarium.switchboard.assistant.withValue
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationCheckResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AutomationCheckTest {
	private val oldFunction = functionRow(
		"shared",
		"Old name",
		listOf("mine", "other"),
		params = listOf(FunctionParam("room", "text"), FunctionParam("lamp", "device")),
		steps = listOf(plugStep("on")),
	)
	private val offer = offerOf(SANDBOX_SERVES, away = false, functions = listOf(oldFunction))
	private val context = EditContext(offer, emptyList())
	private val pointer = AutomationAction.RunFunction(
		"shared",
		values = buildJsonObject { put("room", "Bedroom"); put("lamp", SANDBOX_SWITCH) },
	)
	private val automation = Automation(
		enabled = true,
		trigger = CROSSING,
		actions = listOf(pointer),
	)
	private val draft = automationDraftOf(automationRow("mine", "Mine", listOf(pointer)), context)!!

	private fun saveOp(automation: Automation = this.automation) =
		ConsoleOp.AutomationSave(automationId = "mine", automation = automation, automationBase = 2L)

	private fun refused(code: String, record: String? = null, path: String? = null, param: String? = null) =
		ConsoleAutomationCheckResult(
			ready = false,
			refusal = AutomationSaveRefusal(code = code, record = record, path = path, param = param, start = 1L, end = 3L),
		)

	@Test
	fun checkAnswersMatchTheSaveTheyWereAskedToJudge() {
		val op = saveOp()
		val answer = ConsoleAutomationCheckResult(ready = true, reads = FunctionReads(listOf("room"), emptyList()))
		val read = CheckRead(op, answer)

		assertEquals(answer, checkedFor(read, op))
		assertNull(checkedFor(read, saveOp(op.automation.copy(enabled = false))))
		assertNull(checkedFor(read, null))
		assertEquals(answer.reads, checkedReads(read, "shared"))
		assertNull(checkedReads(read, "another"))
		assertEquals(answer.reads, checkedReads(CheckRead(saveOp(automation.copy(enabled = false)), answer), "shared"))
	}

	@Test
	fun checkRefusalsUseTheSaveMappingAndOnlyCurrentBlockingKinds() {
		val movedFunction = refused(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, Protocol.Wire.AutomationSaveRecord.FUNCTION.wire)
		val movedAutomation = refused(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire)
		val confirmation = refused(Protocol.Wire.AutomationSaveRefusalCode.CONFIRM.wire)
		val hole = refused(
			Protocol.Wire.AutomationSaveRefusalCode.HOLE.wire,
			Protocol.Wire.AutomationSaveRecord.FUNCTION.wire,
			path = "0",
			param = "message",
		)
		val fieldDraft = draft.copy(steps = listOf(StepDraft.Do(draft.steps.single().key, toldDraft("now", "Hi"))))
		val invalid = refused(
			Protocol.Wire.AutomationSaveRefusalCode.INVALID.wire,
			Protocol.Wire.AutomationSaveRecord.FUNCTION.wire,
			path = "steps.0.message",
			param = "message",
		)

		assertNull(checkSaidOf(null, draft, context))
		assertNull(checkSaidOf(ConsoleAutomationCheckResult(ready = true), draft, context))
		assertNull(checkSaidOf(movedAutomation, draft, context))
		assertNull(checkSaidOf(confirmation, draft, context))
		assertEquals(AutomationSaid.FunctionMoved("shared"), checkSaidOf(movedFunction, draft, context))
		assertTrue(checkSaidOf(refused(Protocol.Wire.AutomationSaveRefusalCode.NO_KEY.wire), draft, context) is AutomationSaid.Line)
		assertEquals(
			AutomationSaid.Hole::class,
			checkSaidOf(hole, fieldDraft, context)?.let { it::class },
		)
		val field = checkSaidOf(invalid, fieldDraft, context) as AutomationSaid.Field
		assertEquals(SaidAt.Card(fieldDraft.steps.single().key, "message"), field.at)
		assertEquals("Hi", field.text)
	}

	@Test
	fun aNullAnswerKeepsTheHeldCheckAndAnAnswerReplacesItWithItsOp() {
		val op = saveOp()
		val answer = ConsoleAutomationCheckResult(ready = true)
		val held = CheckRead(saveOp(automation.copy(enabled = false)), ConsoleAutomationCheckResult(ready = false))

		assertEquals(held, checkAfter(held, op, null))
		assertEquals(CheckRead(op, answer), checkAfter(held, op, answer))
	}

	@Test
	fun aMovedFunctionBlocksSaveAndOffersReloadOnlyWhileItIsStillPointedAt() {
		val runs = draft.runsDraft()
		val moved = AutomationSaid.FunctionMoved("shared")
		val refusal = AutomationSaid.Line("held")
		val other = functionRow("other", "Other", listOf("theirs"))
		val repointedDraft = draft.pointedTo(other, offerOf(SANDBOX_SERVES, away = false, functions = listOf(oldFunction, other)))
		val repointed = repointedDraft.runsDraft()
		val fresh = (runs as RunsDraft.Pointing).copy(mode = PointMode.NEW)

		assertFalse(saveAllowedAfterCheck(refusal, null, draft, draft.context.offer))
		assertFalse(saveAllowedAfterCheck(null, moved, draft, draft.context.offer))
		assertTrue(saveAllowedAfterCheck(null, refusal, draft, draft.context.offer))
		assertTrue(saveAllowedAfterCheck(null, null, draft, draft.context.offer))
		assertEquals(listOf(true, false, false), listOf(runs, repointed, fresh).map { movedFor(moved, it) })
		assertTrue(saveAllowedAfterCheck(null, moved, repointedDraft, repointedDraft.context.offer))
	}

	@Test
	fun aSaveRefusedForItsFunctionSaysWhichFunctionMovedAndForTheAutomationOffersTheRebase() {
		val saveRefusal = AutomationSaveRefusal(
			code = Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire,
			record = Protocol.Wire.AutomationSaveRecord.FUNCTION.wire,
			revision = 5L,
		)
		val saved = automationSavedOf(
			ConsoleAutomationSaveResult(stored = false, refusal = saveRefusal),
			"mine",
		)
		val fresh = draft.withRuns((draft.runsDraft() as RunsDraft.Pointing).copy(mode = PointMode.NEW))
		assertEquals(
			AutomationOutcome.Said(AutomationSaid.FunctionMoved("shared")),
			outcomeOf(saved, draft, deleting = false, context),
		)
		val unreloadable = outcomeOf(saved, fresh, deleting = false, context) as AutomationOutcome.Said
		assertTrue(unreloadable.said is AutomationSaid.Line)

		val held = automationRow("mine", "New", listOf(AutomationAction.TellAssistant("now"))).copy(revision = 3L)
		val automationRefusal = automationSavedOf(
			ConsoleAutomationSaveResult(
				stored = false,
				refusal = AutomationSaveRefusal(
					code = Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire,
					record = Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire,
				),
			),
			"mine",
			held,
		)
		assertTrue(outcomeOf(automationRefusal, draft, deleting = false, context) is AutomationOutcome.Offer)
	}

	@Test
	fun reloadUsesTheListedBodyAndKeepsOnlyValuesWithMatchingNameAndType() {
		val runs = draft.runsDraft() as RunsDraft.Pointing
		val edited = draft.withRuns(runs.copy(steps = listOf((runs.steps.single() as StepDraft.Do).let { it.copy(action = withValue(it.action, "verb", "off")) })))
		val changed = oldFunction.copy(
			revision = 8L,
			function = AutomationFunction(
				name = "New name",
				params = listOf(FunctionParam("room", "text"), FunctionParam("lamp", "text")),
				steps = listOf(plugStep("toggle")),
			),
		)
		val (reloaded, dropped) = edited.reloadedFunction(changed, offer)
		val reloadedRuns = reloaded.runsDraft() as RunsDraft.Pointing

		assertTrue(dropped)
		assertEquals(8L to "New name", reloadedRuns.base to reloadedRuns.name)
		assertEquals(PointMode.SHARED, reloadedRuns.mode)
		assertEquals(mapOf("room" to "Bedroom"), reloadedRuns.valuesByName())
		assertEquals(written(changed.function), reloadedRuns.steps.map { stepOfDraft(it, offer, reloadedRuns.params) })
	}

	@Test
	fun reloadMarksUniqueOrChangedBodiesAsDroppedAndLeavesOtherPointersAlone() {
		val runs = draft.runsDraft() as RunsDraft.Pointing
		val unique = draft.withRuns(runs.copy(mode = PointMode.UNIQUE))
		assertTrue(unique.reloadedFunction(oldFunction, offer).second)
		assertFalse(draft.reloadedFunction(oldFunction, offer).second)
		val other = oldFunction.copy(id = "other")
		assertEquals(draft to false, draft.reloadedFunction(other, offer))
		val flat = draft.copy(runs = com.atelier_nyaarium.switchboard.assistant.RunsHead.Own)
		assertEquals(flat to false, flat.reloadedFunction(oldFunction, offer))
	}
}
