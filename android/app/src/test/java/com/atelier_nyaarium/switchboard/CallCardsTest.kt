package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.CallChoice
import com.atelier_nyaarium.switchboard.assistant.CallLine
import com.atelier_nyaarium.switchboard.assistant.CallValue
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.RefusedAt
import com.atelier_nyaarium.switchboard.assistant.RunsIssue
import com.atelier_nyaarium.switchboard.assistant.SaidAt
import com.atelier_nyaarium.switchboard.assistant.Slot
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.ValueSource
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.callChoices
import com.atelier_nyaarium.switchboard.assistant.callLine
import com.atelier_nyaarium.switchboard.assistant.canRemove
import com.atelier_nyaarium.switchboard.assistant.draftRunsIssue
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.mirrorKey
import com.atelier_nyaarium.switchboard.assistant.pointedTo
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.stepOfDraft
import com.atelier_nyaarium.switchboard.assistant.treeOf
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.StepArg
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallCardsTest {
	private val none = SourceFields(emptyList())

	private fun arg(value: StepArg) = wireJson.encodeToJsonElement(StepArg.serializer(), value)

	private fun call(function: String, vararg values: Pair<String, StepArg>) =
		FunctionStep.Call(function, JsonObject(values.associate { (name, value) -> name to arg(value) }).takeIf { values.isNotEmpty() })

	private val chime = functionRow(
		"chime",
		"Chime",
		emptyList(),
		params = listOf(FunctionParam("count", "number"), FunctionParam("label", "text")),
		steps = listOf(plugStep("on")),
	).copy(callers = listOf("warm-up"))
	private val warmUp = functionRow("warm-up", "Warm up", listOf("mine"), steps = listOf(call("chime", "count" to StepArg.Literal(JsonPrimitive(2)))))
	private val offer = offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, chime))
	private val pointer = Automation(enabled = true, trigger = CROSSING, actions = listOf(AutomationAction.RunFunction(function = "warm-up")))

	private fun opened(using: AutomationOffer = offer) =
		automationDraftOf(AutomationRow("mine", 2L, pointer, "Thermometer above 26 °C"), EditContext(using, emptyList()))!!

	private fun callKey(draft: com.atelier_nyaarium.switchboard.assistant.AutomationDraft) =
		draft.steps.single { it is StepDraft.Call }.key

	@Test
	fun aCallReadsItsValuesAsTypedOrReadAndWritesThemBackByTheCalleesTypes() {
		val stored = call(
			"chime",
			"count" to StepArg.Literal(JsonPrimitive(3)),
			"label" to StepArg.Literal(JsonPrimitive("hall")),
			"room" to StepArg.Expression("device"),
		)
		val card = treeOf(stored, offer) as StepDraft.Call

		assertEquals(
			mapOf("count" to CallValue.Typed("3"), "label" to CallValue.Typed("hall"), "room" to CallValue.Read("device")),
			card.values,
		)
		assertEquals(stored, stepOfDraft(card, offer))
		assertTrue(treeOf(call("chime", "count" to StepArg.Literal(JsonPrimitive(true))), offer) is StepDraft.Kept)
		// A blank typed value is left to the trigger.
		assertEquals(call("chime"), stepOfDraft(card.copy(values = mapOf("count" to CallValue.Typed(" "))), offer))
	}

	@Test
	fun aSaveSendsTheCalleesItStillReachesAndChangedEachWithTheBaseItRead() {
		val draft = opened()
		val callee = draft.openedCallee("chime", offer)
		val edited = callee.plusStep(Slot(null, null, 1), StepDraft.Exit("stop"), tree = "chime")
		val made = edited.withNewCallee(callKey(edited), "Bell")
		val bell = made.callees.values.single { it.name == "Bell" }.id
		val ringing = made.plusStep(Slot(null, null, 0), StepDraft.Do("ring", plugDraft(SANDBOX_SWITCH, "toggle")), tree = bell)

		assertNull(functionSaveOf(callee, none, offer, false)!!.called)
		assertEquals(listOf("chime" to 3L), functionSaveOf(edited, none, offer, false)!!.called!!.map { it.id to it.base })
		// The card now calls Bell, so Chime is no longer reached.
		val sent = functionSaveOf(ringing, none, offer, false)!!.called!!
		assertEquals(listOf(bell to 0L), sent.map { it.id to it.base })
		assertEquals("Bell", sent.single().body.name)
	}

	@Test
	fun aCalleeWithNothingToRunIsNamedOnTheAutomationsPage() {
		val made = opened().let { it.withNewCallee(callKey(it), "Bell") }

		assertEquals(RunsIssue.InCallee("Bell"), draftRunsIssue(made, none, offer))
		assertNull(functionSaveOf(made, none, offer, false))
	}

	@Test
	fun theCallPickerLeavesOutItsOwnFunctionWhatCallsBackAndUnnamedOnes() {
		val unnamed = functionRow("own", "", listOf("other"))
		val calledBack = functionRow("back", "Back", listOf("other"), steps = listOf(call("warm-up")))
		val wide = offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, chime, unnamed, calledBack))
		val draft = opened(wide)

		assertEquals(
			listOf(CallChoice.Existing("chime", "Chime"), CallChoice.New),
			callChoices(draft, wide, tree = null),
		)
	}

	@Test
	fun aCalleesCardsAreEditedMovedAndRemovedInItsOwnTreeAndSavedThatWay() {
		val draft = opened().openedCallee("chime", offer)
		val top = draft.stepsOf("chime").single().key
		val added = draft.plusStep(Slot(null, null, 1), StepDraft.Note("n", "hello"), tree = "chime")
		val renamed = added.movedTo("n", Slot(null, null, 0)).withStep("n") { (it as StepDraft.Note).copy(text = "bye") }
		fun saved(of: com.atelier_nyaarium.switchboard.assistant.AutomationDraft) =
			functionSaveOf(of, none, offer, false)!!.called?.single()?.body?.let { com.atelier_nyaarium.switchboard.assistant.written(it) }

		assertEquals(listOf(FunctionStep.Note("bye"), plugStep("on")), saved(renamed))
		assertEquals(functionSaveOf(draft, none, offer, false)!!.function, functionSaveOf(renamed, none, offer, false)!!.function)
		assertEquals(listOf(true, false), listOf(canRemove(added, top, offer), canRemove(draft, top, offer)))
		assertNull(saved(renamed.minusStep("n")))
	}

	@Test
	fun aRefusalNamingACalledFunctionLandsOnItsCard() {
		val draft = opened().openedCallee("chime", offer)
		val calleeCard = draft.stepsOf("chime").single().key
		val refused = AutomationSaved.Refused("invalid", at = RefusedAt.Step("0", "device", "chime"))

		val said = (outcomeOf(refused, draft, deleting = false, draft.context) as AutomationOutcome.Said).said as AutomationSaid.Field
		assertEquals(SaidAt.Card(calleeCard, "device"), said.at)
	}

	@Test
	fun backClosesTheTextPageThenThePickerThenTheInnermostCallee() {
		val deep = opened().openedCallee("chime", offer).copy(picking = true)
		val withText = deep.copy(text = com.atelier_nyaarium.switchboard.assistant.TextRef("k", "message"))
		val first = AUTOMATION_PAGES.close(withText)
		val second = AUTOMATION_PAGES.close(first)
		val third = AUTOMATION_PAGES.close(second)

		assertEquals(listOf(null, true, listOf("chime")), listOf(first.text, first.picking, first.inside))
		assertEquals(listOf(false, listOf("chime")), listOf(second.picking, second.inside))
		assertEquals(emptyList<String>(), third.inside)
	}

	@Test
	fun aCalleesCardReadsTheCalleesValuesAndTheAutomationsReadItsOwn() {
		val draft = opened().openedCallee("chime", offer)
		val calleeCard = draft.stepsOf("chime").single().key

		assertEquals(listOf("count", "label"), com.atelier_nyaarium.switchboard.assistant.scopeAt(draft, calleeCard)!!.params.map { it.name })
		assertEquals(emptyList<String>(), com.atelier_nyaarium.switchboard.assistant.scopeAt(draft, callKey(draft))!!.params.map { it.name })
		val names = com.atelier_nyaarium.switchboard.assistant.namesAt(draft, offer, calleeCard, null).map { it.name }
		assertTrue(names.containsAll(listOf("count", "label")))
	}

	@Test
	fun aMovedRefusalNamingACalleeOffersThatCalleesReloadAndBlocksSave() {
		val draft = opened().openedCallee("chime", offer)
		fun said(id: String?) = outcomeOf(
			AutomationSaved.Refused("moved", functionMoved = MovedFunction(id)),
			draft,
			deleting = false,
			draft.context,
		)

		assertEquals(AutomationOutcome.Said(AutomationSaid.FunctionMoved("chime")), said("chime"))
		assertEquals(AutomationOutcome.Said(AutomationSaid.FunctionMoved("warm-up")), said(null))
		assertEquals(AutomationOutcome.Said("moved"), said("elsewhere"))
		val moved = AutomationSaid.FunctionMoved("chime")
		assertEquals(false, com.atelier_nyaarium.switchboard.assistant.saveAllowedAfterCheck(null, moved, draft, offer))
		assertEquals(CallLine.Moved("chime"), callLine(draft, offer, moved, "chime"))
	}

	@Test
	fun aCallCardSaysWhenItsCalleeHoldsARefusalOrAProblem() {
		val draft = opened().openedCallee("chime", offer)
		val calleeCard = draft.stepsOf("chime").single().key
		val inCallee = AutomationSaid.Field(SaidAt.Card(calleeCard, "device"), "invalid", "")
		val atCall = AutomationSaid.Field(SaidAt.Card(callKey(draft), "count"), "invalid", "")
		val broken = draft.plusStep(Slot(null, null, 1), StepDraft.Call("c2", "", emptyMap()), tree = "chime")

		assertEquals(CallLine.Attention, callLine(draft, offer, inCallee, "chime"))
		assertEquals(null, callLine(draft, offer, atCall, "chime"))
		assertEquals(CallLine.Attention, callLine(broken, offer, null, "chime"))
		assertEquals(null, callLine(draft, offer, null, "chime"))
	}

	@Test
	fun aCalleeTheAutomationNoLongerCallsNeitherBlocksSaveNorCountsAsAChange() {
		val draft = opened()
		val orphaned = draft.plusStep(Slot(null, null, 1), StepDraft.Call("c2", "", emptyMap()))
			.let { it.withNewCallee("c2", "Bell") }
			.minusStep("c2")

		assertEquals(null, draftRunsIssue(orphaned, none, offer))
		assertEquals(functionSaveOf(draft, none, offer, false), functionSaveOf(orphaned, none, offer, false))
		assertEquals(false, orphaned.changedFrom(draft))
	}

	@Test
	fun thePickerAndTheCardsLineReadTheDraftAsEdited() {
		val plain = functionRow("warm-up", "Warm up", listOf("mine"), steps = listOf(plugStep("on")))
		val bell = functionRow("bell", "Bell", emptyList(), steps = listOf(plugStep("off")))
		val edited = offerOf(SANDBOX_SERVES, away = false, functions = listOf(plain, chime, bell))
		val draft = opened(edited)
			.plusStep(Slot(null, null, 1), StepDraft.Call("c", "chime", emptyMap()))
			.openedCallee("chime", edited)
			.plusStep(Slot(null, null, 1), StepDraft.Call("c3", "bell", emptyMap()), tree = "chime")
			.openedCallee("bell", edited)

		assertEquals(false, callChoices(draft, edited, tree = "chime").contains(CallChoice.Existing("warm-up", "Warm up")))
		assertEquals(CallLine.Moved("bell"), callLine(draft, edited, AutomationSaid.FunctionMoved("bell"), "chime"))
	}

	@Test
	fun aValueTheTriggerGivesIsShownAsGivenAndOthersAreTyped() {
		val given = functionRow(
			"chime",
			"Chime",
			emptyList(),
			params = listOf(FunctionParam("value", "number"), FunctionParam("label", "text")),
		)
		val draft = opened(offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, given)))

		assertEquals(
			listOf(ValueSource.FromTrigger, ValueSource.Unset),
			com.atelier_nyaarium.switchboard.assistant.callRows(draft, draft.context.offer, "chime")!!.map { it.source },
		)
	}

	@Test
	fun aCalleesPageNamesTheOtherAutomationsItsEditsReach() {
		val shared = warmUp.copy(users = listOf("mine", "theirs"))
		val wide = offerOf(SANDBOX_SERVES, away = false, functions = listOf(shared, chime))
		val rows = listOf(AutomationRow("theirs", 1L, pointer, "Every hour"))

		assertEquals(listOf("Every hour"), com.atelier_nyaarium.switchboard.assistant.alsoRunBy(opened(wide), wide, rows, "chime"))
		assertEquals(emptyList<String>(), com.atelier_nyaarium.switchboard.assistant.alsoRunBy(opened(), offer, rows, "chime"))
	}

	@Test
	fun aMovedCalleeTheAutomationNoLongerCallsLeavesSaveAlone() {
		val draft = opened().openedCallee("chime", offer)
		val unhooked = draft.withStep(callKey(draft)) { (it as StepDraft.Call).copy(function = "") }
		val moved = AutomationSaid.FunctionMoved("chime")

		assertEquals(false, com.atelier_nyaarium.switchboard.assistant.saveAllowedAfterCheck(null, moved, draft, offer))
		assertEquals(true, com.atelier_nyaarium.switchboard.assistant.saveAllowedAfterCheck(null, moved, unhooked, offer))
	}

	@Test
	fun theFreshListDecidesReachAndAListedInvalidCalleeMarksItsCard() {
		val bell = functionRow("bell", "Bell", emptyList(), steps = listOf(plugStep("off")))
		val draft = opened(offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, chime, bell)))
		val callsBack = offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, chime, bell.copy(function = bell.function.copy(steps = listOf(call("warm-up"))))))
		val broken = offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, chime.copy(invalid = "broken"), bell))

		assertEquals(false, callChoices(draft, callsBack, tree = null).contains(CallChoice.Existing("bell", "Bell")))
		assertEquals(CallLine.Attention, callLine(draft, broken, null, "chime"))
		assertEquals(null, callLine(draft, offer, null, "chime"))
	}

	@Test
	fun anAnswerThatReplacesACalleeRebuildsTheEditorsCopyAndTypingDoesNot() {
		val draft = opened().openedCallee("chime", offer)
		val typed = draft.plusStep(Slot(null, null, 1), StepDraft.Exit("x"), tree = "chime")
		val reloaded = typed.reloadedCallee(chime.copy(revision = 9L), offer).first

		assertEquals(mirrorKey(draft), mirrorKey(typed))
		assertEquals(false, mirrorKey(typed) == mirrorKey(reloaded))
	}

	@Test
	fun aFunctionPointedAtIsReadFromItsCardsNotAStaleCalleeCopy() {
		val bell = functionRow("bell", "Bell", emptyList(), steps = listOf(plugStep("off")))
		val wide = offerOf(SANDBOX_SERVES, away = false, functions = listOf(warmUp, chime, bell))
		val draft = opened(wide)
			.openedCallee("chime", wide)
			.plusStep(Slot(null, null, 1), StepDraft.Call("cb", "bell", emptyMap()), tree = "chime")
			.openedCallee("bell", wide)
			.pointedTo(chime, wide)

		assertEquals(true, callChoices(draft, wide, tree = "bell").contains(CallChoice.Existing("chime", "Chime")))
	}

	@Test
	fun pointingAtAnOpenedCalleeDropsItsCopySoARefusalLandsOnTheCardsShown() {
		val draft = opened().openedCallee("chime", offer).pointedTo(chime, offer)
		val refused = AutomationSaved.Refused("invalid", at = RefusedAt.Step("0", "device", "chime"))
		val said = (outcomeOf(refused, draft, deleting = false, draft.context) as AutomationOutcome.Said).said as AutomationSaid.Field

		assertEquals(listOf(false, emptyList<String>()), listOf("chime" in draft.callees, draft.inside))
		assertEquals(SaidAt.Card(draft.steps.single().key, "device"), said.at)
	}

	@Test
	fun aValueTypedThenErasedLeavesTheCallAsItWas() {
		val held = mapOf("count" to CallValue.Typed("2"))

		assertEquals(emptyMap<String, CallValue>(), com.atelier_nyaarium.switchboard.assistant.withCallValue(held, "count", CallValue.Typed(" ")))
		assertEquals(held, com.atelier_nyaarium.switchboard.assistant.withCallValue(emptyMap(), "count", CallValue.Typed("2")))
	}

	@Test
	fun aValueItsFunctionNoLongerDeclaresBlocksSaveUntilCleared() {
		val draft = opened()
		val stray = draft.withStep(callKey(draft)) { (it as StepDraft.Call).copy(values = mapOf("room" to CallValue.Typed("hall"))) }

		assertEquals(listOf("room"), com.atelier_nyaarium.switchboard.assistant.strayCallValues(stray.steps.single() as StepDraft.Call, chime.function.params))
		assertTrue(draftRunsIssue(stray, none, offer) is RunsIssue.Step)
		assertNull(functionSaveOf(stray, none, offer, false))
	}

	@Test
	fun aRefusalByPathNamesItsFunctionAndACallCardsFieldIsNotSaidTwice() {
		val refusal = AutomationSaveRefusal(code = "invalid", record = "function", id = "chime", path = "steps.0.device")
		val draft = opened()
		val said = AutomationSaid.Field(SaidAt.Card(callKey(draft), "count"), "invalid", "")

		assertEquals(RefusedAt.Step("0", "device", "chime"), com.atelier_nyaarium.switchboard.assistant.refusedAtOf(refusal))
		assertNull(com.atelier_nyaarium.switchboard.assistant.generalLine(said, draft, offer))
	}

	@Test
	fun openingACalleeChangesNothingAndEditingItDoes() {
		val draft = opened()
		val callee = draft.openedCallee("chime", offer)

		assertEquals(false, callee.changedFrom(draft))
		assertEquals(true, callee.plusStep(Slot(null, null, 0), StepDraft.Exit("x"), tree = "chime").changedFrom(draft))
	}
}
