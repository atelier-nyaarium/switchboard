package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.FunctionLine
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.RunsIssue
import com.atelier_nyaarium.switchboard.assistant.SaveAnswer
import com.atelier_nyaarium.switchboard.assistant.TypeWord
import com.atelier_nyaarium.switchboard.assistant.ValueIssue
import com.atelier_nyaarium.switchboard.assistant.ValueSource
import com.atelier_nyaarium.switchboard.assistant.automationDeleteTakes
import com.atelier_nyaarium.switchboard.assistant.functionLine
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.pickerChoices
import com.atelier_nyaarium.switchboard.assistant.pointedAt
import com.atelier_nyaarium.switchboard.assistant.reachLine
import com.atelier_nyaarium.switchboard.assistant.runsIssue
import com.atelier_nyaarium.switchboard.assistant.saveAnswerOf
import com.atelier_nyaarium.switchboard.assistant.triggerGiven
import com.atelier_nyaarium.switchboard.assistant.valueIssue
import com.atelier_nyaarium.switchboard.assistant.valueRows
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRecord
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRefusalCode
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.GivenType
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal val FN_OFFER = offerOf(SANDBOX_SERVES, away = false)

internal val CROSSING = AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", "above", 26.0, 0.5, 1_800L)

internal fun literal(text: String) = buildJsonObject {
	put("kind", "literal")
	put("value", text)
}

internal fun plugStep(verb: String) = FunctionStep.Do(
	action = "device_set",
	args = JsonObject(mapOf("device" to literal(SANDBOX_SWITCH), "verb" to literal(verb))),
)

internal fun functionRow(
	id: String,
	name: String,
	users: List<String>,
	params: List<FunctionParam> = emptyList(),
	reads: FunctionReads = FunctionReads(emptyList(), emptyList()),
	steps: List<FunctionStep> = listOf(plugStep("on")),
	revision: Long = 3L,
) = AutomationFunctionRow(id, revision, AutomationFunction(name, params, steps), users, moves = false, reads = reads)

internal fun automationRow(id: String, sentence: String, actions: List<AutomationAction>) =
	AutomationRow(id, 2L, Automation(enabled = true, trigger = CROSSING, actions = actions), sentence)

class FunctionRulesTest {
	private val given = triggerGiven("crossing")
	private val tooWarm = functionRow("too-warm", "Too warm", listOf("mine", "downstairs"))
	private val frost = functionRow("frost", "Frost warning", listOf("outside"))
	private val rows = listOf(
		automationRow("mine", "My room thermometer above 26 °C", listOf(AutomationAction.RunFunction(function = "too-warm"))),
		automationRow("downstairs", "Downstairs thermometer above 26 °C", listOf(AutomationAction.RunFunction(function = "too-warm"))),
		automationRow("outside", "Outside below 2 °C", listOf(AutomationAction.RunFunction(function = "frost"))),
		automationRow("plain", "Every day at 18:00", listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on"))),
		automationRow("lost", "A newer build's", listOf(AutomationAction.RunFunction(function = "unread"))),
	)

	@Test
	fun eachValueSaysWhereItComesFromAndHowItsTypeReads() {
		val params = listOf(
			FunctionParam("value", "number"),
			FunctionParam("device", "device"),
			FunctionParam("room", "text"),
			FunctionParam("times", "number"),
		)
		val shown = valueRows(params, given, mapOf("room" to "Bedroom", "times" to " "), measure = "temperature")

		assertEquals(
			listOf(
				TypeWord.Measure("temperature") to ValueSource.FromTrigger,
				TypeWord.Given(GivenType.DEVICE) to ValueSource.FromTrigger,
				TypeWord.Declared("text") to ValueSource.Set("Bedroom"),
				TypeWord.Declared("number") to ValueSource.Unset,
			),
			shown.map { it.type to it.source },
		)
		// The sensor reads as text, shows as a device.
		assertEquals(GivenType.TEXT, given.names.single { it.name == "device" }.type)
		assertEquals(listOf("reason", "id", "title", "url"), triggerGiven("event", eventFields = listOf("reason", "id")).eventFields)
		// No measure known: the type's own word.
		assertEquals(TypeWord.Given(GivenType.NUMBER), valueRows(params.take(1), given, emptyMap(), measure = null).single().type)
		assertEquals(ValueIssue.UNKNOWN_DEVICE, valueIssue(FunctionParam("lamp", "device"), "ff:ff", FN_OFFER))
		assertNull(valueIssue(FunctionParam("lamp", "device"), SANDBOX_SWITCH, FN_OFFER))
		assertEquals(ValueIssue.NOT_A_NUMBER, valueIssue(FunctionParam("times", "number"), "two", FN_OFFER))
		assertNull(valueIssue(FunctionParam("times", "number"), "3", FN_OFFER))
	}

	@Test
	fun saveWaitsForWhatTheRunsBlockStillOwes() {
		val blink = functionRow("blink", "Blink", listOf("mine"), params = listOf(FunctionParam("lamp", "device"), FunctionParam("times", "number")))
		val pointing = pointedAt(RunsDraft.Flat(emptyList()), "mine", blink, FN_OFFER)
		val steps = listOf("tell_assistant", "device_set", "ifttt_trigger")
		fun issue(runs: RunsDraft) = runsIssue(runs, given, FN_OFFER, steps, blink.reads)

		assertEquals(RunsIssue.NoSteps, issue(RunsDraft.Flat(emptyList())))
		assertNull(issue(RunsDraft.Flat(listOf(ActionDraft.Filled("device_set", mapOf("device" to SANDBOX_SWITCH, "verb" to "on"))))))
		val unknown = ActionDraft.Kept(AutomationAction.Unknown("chime", buildJsonObject { put("kind", "chime") }))
		assertEquals(RunsIssue.NotAStep(0), issue(RunsDraft.Flat(listOf(unknown), name = "Chime")))
		assertEquals(RunsIssue.Unset("lamp"), issue(pointing))
		assertEquals(RunsIssue.BadValue("times", ValueIssue.NOT_A_NUMBER), issue(pointing.copy(values = mapOf("lamp" to SANDBOX_SWITCH, "times" to "two"))))
		assertNull(issue(pointing.copy(values = mapOf("lamp" to SANDBOX_SWITCH, "times" to "3"))))
		// Clearing a shared name waits for Make unique.
		val shared = pointedAt(RunsDraft.Flat(emptyList()), "mine", tooWarm, FN_OFFER).copy(name = "")
		assertEquals(RunsIssue.SharedName(2), issue(shared))
		assertNull(issue(shared.copy(mode = PointMode.UNIQUE)))
		assertNull(issue(pointedAt(RunsDraft.Flat(emptyList()), "outside", frost, FN_OFFER).copy(name = "")))
		// Another source's event cannot run here.
		val github = functionRow("wake", "Wake me", listOf("x"), reads = FunctionReads(listOf("event"), listOf("reason")))
		val onEvent = triggerGiven("event", eventFields = listOf("subject"))
		assertTrue(runsIssue(pointedAt(RunsDraft.Flat(emptyList()), "x", github, FN_OFFER), onEvent, FN_OFFER, steps, github.reads) is RunsIssue.Unfit)
	}

	@Test
	fun theListNamesEachRowsFunctionAndCountsOnlyAShared() {
		val functions = listOf(tooWarm, frost)

		assertEquals(FunctionLine.Named("Too warm", 2), functionLine(rows[0], functions))
		assertEquals(FunctionLine.Named("Frost warning", null), functionLine(rows[2], functions))
		assertNull(functionLine(rows[3], functions))
		assertEquals(FunctionLine.Unlisted, functionLine(rows[4], functions))
		assertEquals(listOf("Downstairs thermometer above 26 °C"), reachLine(tooWarm, "mine", rows))
		assertEquals("Frost warning", automationDeleteTakes(rows[2], functions))
		assertNull(automationDeleteTakes(rows[0], functions))
		assertNull(automationDeleteTakes(rows[3], functions))
	}

	@Test
	fun thePickerListsWhatThisTriggerCouldRunMostUsedFirst() {
		val blink = functionRow("blink", "Blink", listOf("a", "b"), params = listOf(FunctionParam("lamp", "device"), FunctionParam("times", "number")))
		val notify = functionRow("notify", "Notify", listOf("c", "d"), params = listOf(FunctionParam("room", "text"), FunctionParam("value", "number")))
		val off = functionRow("off", "Everything off", listOf("e", "f", "g"))
		val github = functionRow("wake", "Wake me", listOf("h", "i", "j", "k"), reads = FunctionReads(listOf("event"), listOf("reason")))
		val asText = functionRow("text", "Says a value", listOf("l"), params = listOf(FunctionParam("value", "text")))

		val picked = pickerChoices(given, listOf(blink, notify, off, github, asText), measure = "temperature")

		assertEquals(listOf("off", "blink", "notify"), picked.map { it.function.id })
		assertEquals(listOf("room" to TypeWord.Declared("text"), "value" to TypeWord.Measure("temperature")), picked[2].signature)
		assertEquals(3, picked[0].count)
	}

	@Test
	fun aSaveAnswerIsReadByItsCode() {
		val stored = automationRow("mine", "s", listOf(AutomationAction.RunFunction(function = "too-warm")))
		assertEquals(SaveAnswer.Stored(stored, tooWarm), saveAnswerOf(ConsoleAutomationSaveResult(stored = true, automation = stored, function = tooWarm)))
		assertEquals(
			SaveAnswer.Confirm(listOf("Send to IFTTT")),
			saveAnswerOf(ConsoleAutomationSaveResult(stored = false, refusal = AutomationSaveRefusal(code = "confirm", labels = listOf("Send to IFTTT")))),
		)
		assertEquals(
			SaveAnswer.Hole(AutomationSaveRecord.FUNCTION, "1", "message", 3L, 9L),
			saveAnswerOf(
				ConsoleAutomationSaveResult(
					stored = false,
					refusal = AutomationSaveRefusal(code = "hole", record = "function", path = "1", param = "message", start = 3L, end = 9L),
				),
			),
		)
		val moved = AutomationSaveRefusal(code = "moved", record = "function", revision = 5L)
		assertEquals(SaveAnswer.Refused(AutomationSaveRefusalCode.MOVED, moved), saveAnswerOf(ConsoleAutomationSaveResult(stored = false, refusal = moved)))
		val later = AutomationSaveRefusal(code = "later_word")
		assertEquals(SaveAnswer.Refused(null, later), saveAnswerOf(ConsoleAutomationSaveResult(stored = false, refusal = later)))
	}
}
