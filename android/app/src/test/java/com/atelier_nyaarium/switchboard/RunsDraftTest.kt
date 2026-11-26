package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.proto.AutomationSwitchOffer
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
import kotlinx.serialization.json.jsonPrimitive
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.runsDraftOf
import com.atelier_nyaarium.switchboard.assistant.saveOpOf
import com.atelier_nyaarium.switchboard.assistant.withValue
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RunsDraftTest {
	private val expression = FunctionStep.Do(
		action = "device_set",
		args = JsonObject(
			mapOf(
				"device" to buildJsonObject {
					put("kind", "expression")
					put("text", "lamp")
				},
				"verb" to literal("toggle"),
			),
		),
	)
	private val blink = functionRow(
		"blink",
		"Blink",
		listOf("mine", "other"),
		params = listOf(FunctionParam("lamp", "device"), FunctionParam("times", "number")),
		steps = listOf(plugStep("on"), expression),
	)
	private val pointer = AutomationAction.RunFunction(
		function = "blink",
		values = buildJsonObject { put("lamp", SANDBOX_SWITCH) },
		keepTryingMin = 5L,
	)
	private var minted = 0

	private fun fresh() = "fn-${++minted}"

	private fun open(actions: List<AutomationAction>) =
		runsDraftOf("mine", Automation(enabled = true, trigger = CROSSING, actions = actions), listOf(blink), FN_OFFER)

	private fun save(runs: RunsDraft): ConsoleOp.AutomationSave? =
		saveOpOf("mine", 2L, runs, FN_OFFER, confirmed = false, freshFunctionId = ::fresh) { actions ->
			Automation(enabled = true, trigger = CROSSING, actions = actions)
		}

	@Test
	fun anUnchangedPointerSavesItsOwnValuesAndLeavesTheFunctionAlone() {
		val runs = open(listOf(pointer)) as RunsDraft.Pointing

		assertEquals(listOf("other"), runs.others)
		assertTrue(runs.steps[0] is ActionDraft.Filled)
		assertTrue(runs.steps[1] is ActionDraft.Kept)
		val op = save(runs.copy(values = runs.values + ("times" to "3")))!!

		assertNull(op.function)
		val sent = written(op.automation).single() as AutomationAction.RunFunction
		assertEquals("blink", sent.function)
		assertEquals(5L, sent.keepTryingMin)
		assertEquals(buildJsonObject {
			put("lamp", SANDBOX_SWITCH)
			put("times", 3)
		}, sent.values)
	}

	@Test
	fun anEditedBodyIsAnEditAndAKeptStepGoesBackAsItCame() {
		val runs = open(listOf(pointer)) as RunsDraft.Pointing
		val edited = runs.copy(steps = listOf(withValue(runs.steps[0], "verb", "off"), runs.steps[1]))

		val function = save(edited)!!.function as AutomationSaveFunction.Edit
		assertEquals("blink" to 3L, function.id to function.base)
		assertEquals(listOf(plugStep("off"), expression), written(function.body))
		// Make unique copies, with the edit.
		val copy = save(edited.copy(mode = PointMode.UNIQUE))!!.function as AutomationSaveFunction.Copy
		assertEquals("blink" to 3L, copy.from to copy.fromBase)
		assertEquals(written(function.body), written(copy.body))
		// A rename alone is an edit too.
		assertEquals("Blink twice", (save(runs.copy(name = "Blink twice"))!!.function as AutomationSaveFunction.Edit).body.name)
	}

	@Test
	fun aNameMakesOwnStepsAFunctionAndClearingItMakesThemOwnAgain() {
		val own = open(listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on"))) as RunsDraft.Flat
		assertNull(save(own)!!.function)
		assertEquals(listOf<AutomationAction>(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on")), written(save(own)!!.automation))

		val named = save(own.copy(name = " Lamp on "))!!
		val made = named.function as AutomationSaveFunction.Edit
		assertEquals(Triple("fn-1", 0L, "Lamp on"), Triple(made.id, made.base, made.body.name))
		assertEquals(listOf(plugStep("on")), written(made.body))
		assertEquals(AutomationAction.RunFunction(function = "fn-1"), written(named.automation).single())

		// Sole user: the steps come back as its own.
		val sole = (open(listOf(pointer)) as RunsDraft.Pointing).copy(others = emptyList(), steps = listOf(ActionDraft.Filled("device_set", mapOf("device" to SANDBOX_SWITCH, "verb" to "on"))))
		assertEquals(listOf<AutomationAction>(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on")), written(save(sole.copy(name = ""))!!.automation))
		// Shared: nothing is built.
		assertNull(save((open(listOf(pointer)) as RunsDraft.Pointing).copy(name = "")))
	}

	@Test
	fun aPointerWhoseFunctionIsNotListedIsSavedAsSent() {
		val lost = AutomationAction.RunFunction(function = "unread", values = buildJsonObject { put("x", JsonPrimitive(1)) })
		val runs = open(listOf(lost))

		assertEquals(RunsDraft.Kept(lost), runs)
		val op = save(runs)!!
		assertNull(op.function)
		assertEquals(listOf<AutomationAction>(lost), written(op.automation))
	}

	@Test
	fun aListedFunctionOpenedAndSavedUntouchedSendsNoFunction() {
		val text = javaClass.classLoader!!.getResourceAsStream("protocol/automation-list-result-functions.json")!!.bufferedReader().use { it.readText() }
		val listed = wireJson.decodeFromString(ConsoleAutomationListResult.serializer(), text)
		val row = listed.automations.single()
		val room = (written(row.automation).single() as AutomationAction.RunFunction).values!!.getValue("room").jsonPrimitive.content
		val offer = offerOf(SANDBOX_SERVES.copy(switches = listOf(AutomationSwitchOffer(room, "Room"))), away = false, functions = listed.functions)
		val draft = automationDraftOf(row, EditContext(offer, emptyList()))!!

		assertNull(functionSaveOf(draft, SourceFields(emptyList()), offer, confirmed = false) { "fn" }!!.function)
	}
}
