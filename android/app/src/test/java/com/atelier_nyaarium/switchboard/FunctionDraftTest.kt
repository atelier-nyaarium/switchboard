package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.FunctionsServed
import com.atelier_nyaarium.switchboard.assistant.functionsServed
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.assistant.FunctionLine
import com.atelier_nyaarium.switchboard.assistant.RunsHead
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
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import kotlinx.serialization.json.buildJsonObject
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

	@Test
	fun aGatewayThatHoldsNoFunctionsOpensListsAndSavesAsToday() {
		val draft = automationDraftOf(plain, older)!!
		val today = automationEditing(AutomationSlot.Held("mine"), draft, none, offered = true, busy = false, gone = false, offer = older.offer)

		assertEquals(RunsHead.Own(), draft.runs)
		assertNull(runsView(draft, none, older.offer, listOf(plain)))
		assertNull(functionSaveOf(draft, none, older.offer, confirmed = false) { "fn" })
		assertEquals(fittingAutomation(draft, none, older.offer) != null, today.save)
		assertNull(rowFunction(shared, Served.Known(older.offer)))
		assertEquals(FunctionLine.Named("Too warm", 2), rowFunction(shared, Served.Known(serving.offer)))
	}

	@Test
	fun ownStepsBecomeAFunctionOnlyOnceNamed() {
		val draft = automationDraftOf(plain, serving)!!

		assertNull(functionSaveOf(draft, none, serving.offer, confirmed = false) { "fn-1" }!!.function)
		val named = functionSaveOf(draft.withFunctionName("Lamp on"), none, serving.offer, confirmed = false) { "fn-1" }!!
		val made = named.function as AutomationSaveFunction.Edit
		assertEquals(Triple("fn-1", 0L, "Lamp on"), Triple(made.id, made.base, made.body.name))
		assertEquals(AutomationAction.RunFunction(function = "fn-1"), written(named.automation).single())
		// A fresh body waits for a step.
		assertNull(functionSaveOf(draft.freshBody(), none, serving.offer, confirmed = false) { "fn-2" })
	}

	@Test
	fun aPickedFunctionAsksForItsValuesAndMakeUniqueCopiesOnSave() {
		val picked = automationDraftOf(plain, serving)!!.pointedTo(blink, serving.offer)
		val waiting = runsView(picked, none, serving.offer, listOf(plain))!!

		assertEquals(listOf(ValueSource.Unset, ValueSource.Unset), waiting.values.map { it.source })
		assertNull(functionSaveOf(picked, none, serving.offer, confirmed = false) { "fn" })
		val set = picked.withFunctionValue("lamp", SANDBOX_SWITCH).withFunctionValue("times", "3")
		val op = functionSaveOf(set, none, serving.offer, confirmed = false) { "fn" }!!
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
		val unique = sharing.madeUnique()
		assertEquals(true, runsView(unique, none, serving.offer, listOf(shared, hall))!!.unique)
		assertTrue(functionSaveOf(unique, none, serving.offer, confirmed = false) { "fn" }!!.function is AutomationSaveFunction.Copy)
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
}
