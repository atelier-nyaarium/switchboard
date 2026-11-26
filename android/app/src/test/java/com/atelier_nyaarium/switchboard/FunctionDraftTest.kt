package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.RunsIssue
import com.atelier_nyaarium.switchboard.assistant.SaidAt
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.draftRunsIssue
import com.atelier_nyaarium.switchboard.assistant.generalLine
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.pickerSubtitle
import com.atelier_nyaarium.switchboard.assistant.refusedAtOf
import com.atelier_nyaarium.switchboard.assistant.refusedField
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRefusalCode
import com.atelier_nyaarium.switchboard.assistant.FunctionsServed
import com.atelier_nyaarium.switchboard.assistant.FunctionOffer
import com.atelier_nyaarium.switchboard.assistant.functionsServed
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.assistant.FunctionLine
import com.atelier_nyaarium.switchboard.assistant.RunsHead
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.Served
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.ValueSource
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.automationEditing
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.freshBody
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.madeUnique
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.pointedTo
import com.atelier_nyaarium.switchboard.assistant.rowFunction
import com.atelier_nyaarium.switchboard.assistant.runsView
import com.atelier_nyaarium.switchboard.assistant.withFunctionName
import com.atelier_nyaarium.switchboard.assistant.withFunctionValue
import com.atelier_nyaarium.switchboard.assistant.uniqueFunctionName
import com.atelier_nyaarium.switchboard.assistant.withFunctionParam
import com.atelier_nyaarium.switchboard.assistant.withoutFunctionParam
import com.atelier_nyaarium.switchboard.assistant.valuesByName
import com.atelier_nyaarium.switchboard.assistant.wireParams
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.AutomationSwitchOffer
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FunctionDraftTest {
	private val none = SourceFields(emptyList())
	private val blink = functionRow("blink", "Blink", listOf("other"), params = listOf(FunctionParam("lamp", "device"), FunctionParam("times", "number")))
	private val tooWarm = functionRow("too-warm", "Too warm", listOf("mine", "hall"))
	private val serving = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(blink, tooWarm)), emptyList())
	private val older = EditContext(offerOf(SANDBOX_SERVES.copy(functions = null), away = false), emptyList())
	private val plain = automationRow("mine", "My room above 26 °C", listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on")))
	private val shared = automationRow("mine", "My room above 26 °C", listOf(AutomationAction.RunFunction(function = "too-warm")))
	private val hall = automationRow("hall", "Hall above 28 °C", listOf(AutomationAction.RunFunction(function = "too-warm")))
	private fun valueKey(draft: com.atelier_nyaarium.switchboard.assistant.AutomationDraft, name: String): String =
		(draft.runsDraft() as RunsDraft.Pointing).params.single { it.param.name == name }.key
	private fun expressionStep(name: String) = FunctionStep.Do(
		action = "device_set",
		args = JsonObject(mapOf(
			"device" to buildJsonObject { put("kind", "expression"); put("text", name) },
			"verb" to buildJsonObject { put("kind", "literal"); put("value", "on") },
		)),
	)
	private fun twoDeviceValues(): Pair<com.atelier_nyaarium.switchboard.assistant.AutomationDraft, com.atelier_nyaarium.switchboard.assistant.AutomationOffer> {
		val function = functionRow(
			"two-devices",
			"Two devices",
			listOf("mine"),
			params = listOf(FunctionParam("lamp", "device"), FunctionParam("lamp2", "device")),
			steps = listOf(expressionStep("lamp"), expressionStep("lamp2")),
		)
		val offer = offerOf(
			SANDBOX_SERVES.copy(switches = listOf(
				AutomationSwitchOffer("switch-a", "Lamp A"),
				AutomationSwitchOffer("switch-b", "Lamp B"),
			)),
			away = false,
			functions = listOf(function),
		)
		val owner = AutomationRow(
			"mine",
			2L,
			Automation(enabled = true, trigger = CROSSING, actions = listOf(AutomationAction.RunFunction(
				"two-devices",
				values = buildJsonObject { put("lamp", "switch-a"); put("lamp2", "switch-b") },
			))),
			"Mine",
		)
		return automationDraftOf(owner, EditContext(offer, emptyList()))!! to offer
	}

	@Test
	fun aGatewayThatHoldsNoFunctionsOpensListsAndSavesAsToday() {
		val draft = automationDraftOf(plain, older)!!
		val today = automationEditing(AutomationSlot.Held("mine"), draft, none, offered = true, busy = false, gone = false, offer = older.offer)

		assertEquals(RunsHead.Own, draft.runs)
		assertNull(runsView(draft, none, older.offer, listOf(plain)))
		assertNull(functionSaveOf(draft, none, older.offer, confirmed = false))
		assertEquals(fittingAutomation(draft, none, older.offer) != null, today.save)
		assertNull(rowFunction(shared, Served.Known(older.offer)))
		assertEquals(FunctionLine.Named("Too warm", 2), rowFunction(shared, Served.Known(serving.offer)))
	}

	@Test
	fun ownStepsBecomeAFunctionOnlyOnceNamed() {
		val draft = automationDraftOf(plain, serving)!!

		assertNull(functionSaveOf(draft, none, serving.offer, confirmed = false)!!.function)
		val namedDraft = draft.withFunctionName("Lamp on")
		val pointing = namedDraft.runsDraft() as com.atelier_nyaarium.switchboard.assistant.RunsDraft.Pointing
		assertEquals(listOf(PointMode.NEW, 0L), listOf(pointing.mode, pointing.base))
		assertTrue(pointing.functionId.startsWith("fn-"))
		assertEquals(pointing.functionId, (namedDraft.withFunctionName("Lamp on again").runsDraft() as com.atelier_nyaarium.switchboard.assistant.RunsDraft.Pointing).functionId)
		val named = functionSaveOf(namedDraft, none, serving.offer, confirmed = false)!!
		val retry = functionSaveOf(namedDraft, none, serving.offer, confirmed = false)!!
		val made = named.function as AutomationSaveFunction.Edit
		assertEquals(Triple(pointing.functionId, 0L, "Lamp on"), Triple(made.id, made.base, made.body.name))
		assertEquals(made.id, (retry.function as AutomationSaveFunction.Edit).id)
		assertEquals(AutomationAction.RunFunction(function = made.id), written(named.automation).single())
		val cleared = namedDraft.withFunctionName("")
		assertTrue(cleared.runsDraft() is com.atelier_nyaarium.switchboard.assistant.RunsDraft.Flat)
		assertEquals(pointing.functionId, (cleared.withFunctionName("Again").runsDraft() as com.atelier_nyaarium.switchboard.assistant.RunsDraft.Pointing).functionId)
		// A fresh body waits for a step.
		assertNull(functionSaveOf(draft.freshBody(), none, serving.offer, confirmed = false))
	}

	@Test
	fun aPickedFunctionAsksForItsValuesAndMakeUniqueCopiesOnSave() {
		val picked = automationDraftOf(plain, serving)!!.pointedTo(blink, serving.offer)
		val waiting = runsView(picked, none, serving.offer, listOf(plain))!!

		assertEquals(listOf(ValueSource.Unset, ValueSource.Unset), waiting.values.map { it.source })
		assertNull(functionSaveOf(picked, none, serving.offer, confirmed = false))
		val set = picked.withFunctionValue(valueKey(picked, "lamp"), SANDBOX_SWITCH).withFunctionValue(valueKey(picked, "times"), "3")
		val op = functionSaveOf(set, none, serving.offer, confirmed = false)!!
		assertNull(op.function)
		assertEquals(
			buildJsonObject {
				put("lamp", SANDBOX_SWITCH)
				put("times", 3)
			},
			(written(op.automation).single() as AutomationAction.RunFunction).values,
		)

		val sharing = automationDraftOf(shared, serving)!!
		val view = runsView(sharing, none, serving.offer, listOf(shared, hall))!!
		assertEquals(Triple(2, listOf("Hall above 28 °C"), true), Triple(view.usedBy, view.reach, view.makeUnique))
		val unique = sharing.madeUnique(serving.offer)
		assertEquals(true, runsView(unique, none, serving.offer, listOf(shared, hall))!!.unique)
		assertEquals("Too warm.001", (unique.runsDraft() as com.atelier_nyaarium.switchboard.assistant.RunsDraft.Pointing).name)
		val copy = functionSaveOf(unique, none, serving.offer, confirmed = false)!!.function as AutomationSaveFunction.Copy
		assertEquals("Too warm.001", copy.body.name)
		val renamedCopy = functionSaveOf(unique.withFunctionName("Warm again", serving.offer.functions), none, serving.offer, confirmed = false)!!.function as AutomationSaveFunction.Copy
		assertEquals("Warm again", renamedCopy.body.name)
	}

	@Test
	fun makeUniqueUsesTheOpenedNameAndLiveFunctionOffer() {
		val copiedElsewhere = functionRow("copy", "Too warm.001", listOf("elsewhere"))
		val live = serving.offer.copy(functions = FunctionOffer(SANDBOX_SERVES.functions!!, listOf(blink, tooWarm, copiedElsewhere)))
		val cleared = automationDraftOf(shared, serving)!!.withFunctionName("", serving.offer.functions)
		val unique = cleared.madeUnique(live)

		assertEquals("Too warm.002", (unique.runsDraft() as RunsDraft.Pointing).name)
	}

	@Test
	fun valueRowsKeepTheirValuesAndStepsAcrossANameCollisionAndSaveCurrentNames() {
		val (opened, offer) = twoDeviceValues()
		val secondKey = valueKey(opened, "lamp2")
		val crossed = opened.withFunctionParam(secondKey, FunctionParam("lamp", "device"))
		val renamed = crossed.withFunctionParam(secondKey, FunctionParam("lamp3", "device"))
		val runs = renamed.runsDraft() as RunsDraft.Pointing

		assertEquals(mapOf("lamp" to "switch-a", "lamp3" to "switch-b"), runs.valuesByName())
		assertEquals(listOf("lamp", "lamp3"), runs.wireParams().map { it.name })
		assertEquals(listOf("lamp", "lamp2"), runs.steps.filterIsInstance<StepDraft.Do>().map { step ->
			(step.action as ActionDraft.Filled).references.getValue("device").name
		})
		assertEquals(listOf(runs.params[0].key, runs.params[1].key), runs.steps.filterIsInstance<StepDraft.Do>().map { step ->
			(step.action as ActionDraft.Filled).references.getValue("device").key
		})

		val op = functionSaveOf(renamed, none, offer, confirmed = false)!!
		val savedFunction = (op.function as AutomationSaveFunction.Edit).body
		assertEquals(listOf("lamp", "lamp3"), savedFunction.params.map { it.name })
		val deviceArg = wireJson.decodeFromJsonElement(StepArg.serializer(), (written(savedFunction)[1] as FunctionStep.Do).args.getValue("device"))
		assertEquals(StepArg.Expression("lamp3"), deviceArg)
		assertEquals(
			buildJsonObject { put("lamp", "switch-a"); put("lamp3", "switch-b") },
			(written(op.automation).single() as AutomationAction.RunFunction).values,
		)
	}

	@Test
	fun blankRowsKeepDistinctValuesAndReferences() {
		val (opened, _) = twoDeviceValues()
		val firstKey = valueKey(opened, "lamp")
		val secondKey = valueKey(opened, "lamp2")
		val draft = opened
			.withFunctionParam(firstKey, FunctionParam("", "device"))
			.withFunctionParam(secondKey, FunctionParam("", "device"))
		val runs = draft.runsDraft() as RunsDraft.Pointing

		assertEquals(setOf(firstKey, secondKey), runs.values.keys)
		assertEquals(listOf(firstKey, secondKey), runs.steps.filterIsInstance<StepDraft.Do>().map { (it.action as ActionDraft.Filled).references.getValue("device").key })
		assertNull(functionSaveOf(draft, none, draft.context.offer, confirmed = false))
	}

	@Test
	fun removingAValueKeepsItsStepReferenceAndBlocksSave() {
		val (opened, offer) = twoDeviceValues()
		val secondKey = valueKey(opened, "lamp2")
		val removed = opened.withoutFunctionParam(secondKey)
		val runs = removed.runsDraft() as RunsDraft.Pointing

		assertEquals(secondKey, ((runs.steps[1] as StepDraft.Do).action as ActionDraft.Filled).references.getValue("device").key)
		assertEquals(RunsIssue.Step(runs.steps[1].key, "lamp2 is no longer a value; pick again"), draftRunsIssue(removed, none, offer))
		assertNull(functionSaveOf(removed, none, offer, confirmed = false))
	}

	@Test
	fun aRemovedValueIsNamedAsItStoodWhenRemoved() {
		val (opened, _) = twoDeviceValues()
		val secondKey = valueKey(opened, "lamp2")
		val removed = opened.withFunctionParam(secondKey, FunctionParam("lamp3", "device")).withoutFunctionParam(secondKey)
		val runs = removed.runsDraft() as RunsDraft.Pointing

		assertEquals("lamp3", ((runs.steps[1] as StepDraft.Do).action as ActionDraft.Filled).references.getValue("device").name)
	}

	@Test
	fun valueNamesAtThirtyTwoCharactersPassAndThirtyThreeAreRefused() {
		val (opened, offer) = twoDeviceValues()
		val secondKey = valueKey(opened, "lamp2")
		val valid = opened.withFunctionParam(secondKey, FunctionParam("x".repeat(32), "device"))
		val invalidName = "x".repeat(33)
		val invalid = opened.withFunctionParam(secondKey, FunctionParam(invalidName, "device"))

		assertNull(draftRunsIssue(valid, none, offer))
		assertEquals(RunsIssue.BadParam(invalidName, com.atelier_nyaarium.switchboard.assistant.ParamIssue.INVALID), draftRunsIssue(invalid, none, offer))
		assertNull(functionSaveOf(invalid, none, offer, confirmed = false))
	}

	@Test
	fun numberedCopiesChooseTheFirstFreeSuffixAndKeepItWhole() {
		assertEquals("Too warm.001", uniqueFunctionName("Too warm", listOf("Too warm")))
		assertEquals("Too warm.002", uniqueFunctionName("Too warm.001", listOf("Too warm.001")))
		assertEquals("Too warm.002", uniqueFunctionName("Too warm.003", listOf("Too warm.001", "Too warm.003")))
		val long = "x".repeat(Protocol.Wire.FUNCTION_NAME_MAX + 12)
		val shortened = uniqueFunctionName(long, emptyList())
		assertEquals(Protocol.Wire.FUNCTION_NAME_MAX, shortened.length)
		assertTrue(shortened.endsWith(".001"))
		val full = (1..999).map { "Too warm.${it.toString().padStart(3, '0')}" }
		assertEquals("Too warm", uniqueFunctionName("Too warm", full))
	}

	@Test
	fun whoAnEditReachesIsReadFromTheLiveRow() {
		val alone = functionRow("too-warm", "Too warm", listOf("mine"))
		val opened = automationDraftOf(shared, EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(alone)), emptyList()))!!
		// Hall joins meanwhile.
		val live = serving.offer
		val view = runsView(opened, none, live, listOf(shared, hall))!!

		assertEquals(Triple(2, listOf("Hall above 28 °C"), true), Triple(view.usedBy, view.reach, view.makeUnique))
		val cleared = opened.withFunctionName("", live.functions)
		assertNull(functionSaveOf(cleared, none, live, confirmed = false))
		assertTrue(runsView(cleared, none, live, listOf(shared, hall))!!.issue is RunsIssue.SharedName)
	}

	@Test
	fun aDestinationServesFunctionsDoesNotOrIsStillUnread() {
		fun registry(list: GatewayList<AutomationRow>, serves: AutomationServes?) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(GatewayEntry("mikan", connected = true, incarnation = 1L, lastRegisteredAt = 1L, automations = list, automationServes = serves)),
		)
		val home = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null)
		val listed = GatewayList.Listed(emptyList<AutomationRow>())
		fun served(list: GatewayList<AutomationRow>, serves: AutomationServes? = SANDBOX_SERVES) =
			functionsServed(registry(list, serves), home, "mikan")

		assertEquals(FunctionsServed.Serves(SANDBOX_SERVES.functions!!), served(listed))
		assertEquals(FunctionsServed.None, served(listed, SANDBOX_SERVES.copy(functions = null)))
		assertEquals(FunctionsServed.None, served(GatewayList.NotServed))
		assertEquals(FunctionsServed.Reading, served(GatewayList.Unread))
		assertEquals(FunctionsServed.Unreachable, served(GatewayList.Unreachable))
		assertEquals(FunctionsServed.Reading, functionsServed(registry(listed, SANDBOX_SERVES), AssistantHome.Unread, "mikan"))
	}

	@Test
	fun aMoveCarriesTheFunctionsItsEventAutomationsRunAndNoneOtherwise() {
		val state = ConsoleAssistantStateResult(workdir = "~/notes", sources = emptyList())
		fun event(id: String, actions: List<AutomationAction>) =
			AutomationRow(id, 1L, Automation(enabled = true, trigger = AutomationTrigger.Event("github", emptyList()), actions = actions), "GitHub")
		val runs = event("wake", listOf(AutomationAction.RunFunction(function = "blink")))
		val clock = automationRow("lamp", "Every day", listOf(AutomationAction.RunFunction(function = "too-warm")))

		assertEquals(listOf("blink"), carriedOf(state, listOf(runs, clock), listOf(blink, tooWarm)).functions?.map { it.id })
		assertNull(carriedOf(state, listOf(event("tell", listOf(AutomationAction.TellAssistant("now")))), listOf(blink)).functions)
		assertNull(carriedOf(state, listOf(runs), null).functions)
	}

	@Test
	fun theBlockLeavesCardIssuesToTheCardsWhileSaveStillWaits() {
		val opened = automationDraftOf(plain, serving)!!
		val blank = opened.withAction(opened.steps[0].key) { ActionDraft.Filled("device_set", emptyMap()) }
		val empty = automationDraftOf(plain, serving)!!.freshBody()
		val long = automationDraftOf(plain, serving)!!.withFunctionName("x".repeat(Protocol.Wire.FUNCTION_NAME_MAX + 1))

		assertEquals(listOf(null, null), listOf(blank, empty).map { runsView(it, none, serving.offer, listOf(plain))!!.issue })
		assertTrue(draftRunsIssue(blank, none, serving.offer) is RunsIssue.Step)
		assertEquals(RunsIssue.NoSteps, draftRunsIssue(empty, none, serving.offer))
		assertEquals(RunsIssue.NameTooLong(Protocol.Wire.FUNCTION_NAME_MAX), runsView(long, none, serving.offer, listOf(plain))!!.issue)
		assertNull(functionSaveOf(long, none, serving.offer, confirmed = false))
	}

	@Test
	fun aFunctionThatCannotRunSaysSoAndNoReachHeaderStandsOverNoRows() {
		val broken = tooWarm.copy(invalid = "it reads a plug this Gateway no longer has")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(blink, broken)), emptyList())
		// Rows unread: a restart.
		val view = runsView(automationDraftOf(shared, context)!!, none, context.offer, emptyList())!!

		assertEquals(broken.invalid, view.invalid)
		assertEquals(Triple(true, emptyList<String>(), false), Triple(view.makeUnique, view.reach, view.reachHeader))
	}

	@Test
	fun pickingTheCurrentFunctionOnlyClosesAndAnUnlistedOneCanBeRepointed() {
		val picked = automationDraftOf(plain, serving)!!.pointedTo(blink, serving.offer)
		val set = picked.withFunctionValue(valueKey(picked, "lamp"), SANDBOX_SWITCH).madeUnique(serving.offer).copy(picking = true)

		assertEquals(set.copy(picking = false), set.pointedTo(blink, serving.offer))
		val lost = automationRow("lost", "Every day", listOf(AutomationAction.RunFunction(function = "unread")))
		val kept = automationDraftOf(lost, serving)!!
		assertTrue(runsView(kept, none, serving.offer, listOf(lost))!!.kept)
		val sent = functionSaveOf(kept.pointedTo(tooWarm, serving.offer), none, serving.offer, confirmed = false)!!
		assertEquals(AutomationAction.RunFunction(function = "too-warm"), written(sent.automation).single())
	}

	@Test
	fun thePickerNamesTheTriggerOnlyWhileItIsTheOneOpened() {
		val crossing = automationDraftOf(shared, serving)!!
		val clock = automationDraftOf(
			AutomationRow("mine", 2L, Automation(enabled = true, trigger = AutomationTrigger.Time("18:00", emptyList(), "UTC"), actions = written(shared.automation)), "Every day"),
			serving,
		)!!

		assertEquals(shared.sentence, pickerSubtitle(crossing.trigger, crossing.trigger, shared.sentence))
		assertNull(pickerSubtitle(clock.trigger, crossing.trigger, shared.sentence))
	}

	@Test
	fun aRefusalLandsOnTheValueOrFieldItNamesUntilThatTextChanges() {
		val picked = automationDraftOf(plain, serving)!!.pointedTo(blink, serving.offer)
			.let { it.withFunctionValue(valueKey(it, "lamp"), SANDBOX_SWITCH) }
			.let { it.withFunctionValue(valueKey(it, "times"), "3") }
		fun said(refusal: AutomationSaveRefusal): AutomationSaid {
			val saved = AutomationSaved.Refused(automationSaveLine(AutomationSaveRefusalCode.INVALID, refusal, picked.id), at = refusedAtOf(refusal))
			return (outcomeOf(saved, picked, deleting = false, serving) as AutomationOutcome.Said).said
		}
		val plug = said(AutomationSaveRefusal(code = "invalid", record = "automation", path = "values.lamp", line = "no such switch on this Gateway"))

		val shown = runsView(picked, none, serving.offer, emptyList(), plug)!!.values.map { it.refused }
		assertEquals(listOf(plug.line, null), shown)
		assertNull(generalLine(plug, picked, serving.offer))
		val retyped = picked.withFunctionValue(valueKey(picked, "lamp"), "aa:bb:cc:dd:ee:02")
		assertEquals(listOf(null, null), runsView(retyped, none, serving.offer, emptyList(), plug)!!.values.map { it.refused })

		// A step's field.
		val step = said(AutomationSaveRefusal(code = "invalid", record = "function", path = "steps.0.device", line = "its values do not fit what it does"))
		assertEquals("its values do not fit what it does", refusedField(step, SaidAt.Card(picked.steps[0].key, "device"), SANDBOX_SWITCH))
		assertNull(generalLine(step, picked, serving.offer))
		val whole = said(AutomationSaveRefusal(code = "invalid", record = "function", path = "steps.0"))
		assertEquals(whole.line, generalLine(whole, picked, serving.offer))
	}
}
