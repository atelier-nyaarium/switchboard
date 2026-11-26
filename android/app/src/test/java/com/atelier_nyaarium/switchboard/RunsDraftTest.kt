package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.FunctionValueDraft
import com.atelier_nyaarium.switchboard.assistant.FunctionValueReference
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.pointedAt
import com.atelier_nyaarium.switchboard.proto.AutomationSwitchOffer
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
import kotlinx.serialization.json.jsonPrimitive
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.runsDraftOf
import com.atelier_nyaarium.switchboard.assistant.saveOpOf
import com.atelier_nyaarium.switchboard.assistant.stepDraftOf
import com.atelier_nyaarium.switchboard.assistant.stepOf
import com.atelier_nyaarium.switchboard.assistant.withReference
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
	private fun open(actions: List<AutomationAction>) =
		runsDraftOf("mine", Automation(enabled = true, trigger = CROSSING, actions = actions), listOf(blink), FN_OFFER)

	private fun save(runs: RunsDraft): ConsoleOp.AutomationSave? =
		saveOpOf("mine", 2L, runs, FN_OFFER, confirmed = false) { actions ->
			Automation(enabled = true, trigger = CROSSING, actions = actions)
		}

	@Test
	fun anUnchangedPointerSavesItsOwnValuesAndLeavesTheFunctionAlone() {
		val runs = open(listOf(pointer)) as RunsDraft.Pointing

		assertEquals(listOf("other"), runs.others)
		assertTrue(runs.steps[0] is ActionDraft.Filled)
		val lamp = runs.params.single { it.param.name == "lamp" }
		assertEquals(mapOf("device" to FunctionValueReference(lamp.key, "lamp")), (runs.steps[1] as ActionDraft.Filled).references)
		val timesKey = runs.params.single { it.param.name == "times" }.key
		val op = save(runs.copy(values = runs.values + (timesKey to "3")))!!

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

		// Sole user: the steps come back as its own.
		val soleRow = functionRow("solo", "Solo", listOf("mine"), steps = listOf(plugStep("on")))
		val sole = pointedAt(RunsDraft.Flat(emptyList()), "mine", soleRow, FN_OFFER).copy(name = "")
		assertEquals(listOf<AutomationAction>(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on")), written(save(sole)!!.automation))
		// Shared: nothing is built.
		val sharedRow = functionRow("shared", "Shared", listOf("mine", "other"), steps = listOf(plugStep("on")))
		assertNull(save(pointedAt(RunsDraft.Flat(emptyList()), "mine", sharedRow, FN_OFFER).copy(name = "")))
	}

	@Test
	fun aPlugValueExpressionDrawsAndWritesBackButOtherExpressionsAndAsStayKept() {
		val params = listOf(FunctionValueDraft("lamp-row", FunctionParam("lamp", "device")))
		val drawn = stepDraftOf(expression, FN_OFFER, params) as ActionDraft.Filled
		assertEquals(mapOf("device" to FunctionValueReference("lamp-row", "lamp")), drawn.references)
		assertEquals(expression, stepOf(drawn, FN_OFFER, params))
		val unknown = expression.copy(args = JsonObject(mapOf(
			"device" to buildJsonObject { put("kind", "expression"); put("text", "missing") },
			"verb" to literal("toggle"),
		)))
		assertTrue(stepDraftOf(unknown, FN_OFFER, params) is ActionDraft.Kept)
		assertTrue(stepDraftOf(expression.copy(`as` = "result"), FN_OFFER, params) is ActionDraft.Kept)
		val edited = withReference(ActionDraft.Filled("device_set", mapOf("device" to SANDBOX_SWITCH, "verb" to "toggle")), "device", FunctionValueReference("lamp-row", "lamp"))
		assertEquals(expression, stepOf(edited, FN_OFFER, params))
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

		assertNull(functionSaveOf(draft, SourceFields(emptyList()), offer, confirmed = false)!!.function)
	}
}
