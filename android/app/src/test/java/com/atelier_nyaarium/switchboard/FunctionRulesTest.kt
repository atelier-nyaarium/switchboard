package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.FunctionLine
import com.atelier_nyaarium.switchboard.assistant.FunctionParamDraft
import com.atelier_nyaarium.switchboard.assistant.FunctionParamReference
import com.atelier_nyaarium.switchboard.assistant.DeviceOffer
import com.atelier_nyaarium.switchboard.assistant.RunsView
import com.atelier_nyaarium.switchboard.assistant.ValueRow
import com.atelier_nyaarium.switchboard.assistant.canAddParam
import com.atelier_nyaarium.switchboard.assistant.functionParamTypeText
import com.atelier_nyaarium.switchboard.assistant.deviceChoices
import com.atelier_nyaarium.switchboard.assistant.storeDeviceChoice
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.ParamIssue
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.RunsIssue
import com.atelier_nyaarium.switchboard.assistant.SaveAnswer
import com.atelier_nyaarium.switchboard.assistant.TypeWord
import com.atelier_nyaarium.switchboard.assistant.ValueIssue
import com.atelier_nyaarium.switchboard.assistant.ValueSource
import com.atelier_nyaarium.switchboard.assistant.automationDeleteTakes
import com.atelier_nyaarium.switchboard.assistant.functionLine
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.unnamedLine
import com.atelier_nyaarium.switchboard.assistant.pickerChoices
import com.atelier_nyaarium.switchboard.assistant.pointedAt
import com.atelier_nyaarium.switchboard.assistant.reachLine
import com.atelier_nyaarium.switchboard.assistant.RunsNote
import com.atelier_nyaarium.switchboard.assistant.runsIssue
import com.atelier_nyaarium.switchboard.assistant.runsNote
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
import com.atelier_nyaarium.switchboard.proto.SwitchCase
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRecord
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRefusalCode
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.GivenType
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal val FN_OFFER = offerOf(SANDBOX_SERVES, away = false)

internal val CROSSING = AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", "above", 26.0, 0.5, 1_800L)

internal fun literal(text: String) = buildJsonObject {
	put("kind", "literal")
	put("value", text)
}

internal fun plugStep(verb: String) = FunctionStep.Action(
	action = "device_set",
	args = JsonObject(mapOf("device" to literal(SANDBOX_DEVICE), "verb" to literal(verb))),
)

/** Listed rows only. */
internal fun listed(offer: AutomationOffer): com.atelier_nyaarium.switchboard.assistant.CalleeParams =
	{ id -> offer.functions?.row(id)?.function?.params }

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
		automationRow("plain", "Every day at 18:00", listOf(AutomationAction.DeviceSet(SANDBOX_DEVICE, "on"))),
		automationRow("lost", "A newer build's", listOf(AutomationAction.RunFunction(function = "unread"))),
	)
	private fun argsByName(runs: RunsDraft.Pointing, args: Map<String, String>): Map<String, String> =
		runs.params.mapNotNull { row -> args[row.param.name]?.let { row.key to it } }.toMap()

	@Test
	fun eachValueSaysWhereItComesFromAndHowItsTypeReads() {
		val params = listOf(
			FunctionParam("reading", "number"),
			FunctionParam("device", "device"),
			FunctionParam("room", "text"),
			FunctionParam("times", "number"),
		)
		val shown = valueRows(params, given, mapOf("room" to "Bedroom", "times" to " "), measure = "temperature")

		assertEquals(
			listOf(
				TypeWord.Measure("temperature") to ValueSource.FromTrigger,
				TypeWord.Declared("device") to ValueSource.Mismatch(GivenType.TEXT, "device"),
				TypeWord.Declared("text") to ValueSource.Set("Bedroom"),
				TypeWord.Declared("number") to ValueSource.Unset,
			),
			shown.map { it.type to it.source },
		)
		// Sensor reads text.
		assertEquals(GivenType.TEXT, given.names.single { it.name == "device" }.type)
		assertEquals(listOf("reason", "id", "title", "url"), triggerGiven("event", eventFields = listOf("reason", "id")).eventFields)
		// No measure known: the type's own word.
		assertEquals(TypeWord.Given(GivenType.NUMBER), valueRows(params.take(1), given, emptyMap(), measure = null).single().type)
		assertEquals(ValueIssue.UNKNOWN_DEVICE, valueIssue(FunctionParam("lamp", "device"), "ff:ff", FN_OFFER))
		assertNull(valueIssue(FunctionParam("lamp", "device"), SANDBOX_DEVICE, FN_OFFER))
		assertEquals(ValueIssue.NOT_A_NUMBER, valueIssue(FunctionParam("times", "number"), "two", FN_OFFER))
		assertNull(valueIssue(FunctionParam("times", "number"), "3", FN_OFFER))
		assertEquals(listOf(ValueIssue.NOT_A_NUMBER, ValueIssue.NOT_A_NUMBER), listOf("NaN", "Infinity").map { valueIssue(FunctionParam("times", "number"), it, FN_OFFER) })
	}

	@Test
	fun deviceChoicesPutDeviceParamsBeforeDevicesAndStoreReferencesByKey() {
		val params = listOf(
			FunctionParamDraft("lamp-key", FunctionParam("lamp", "device")),
			FunctionParamDraft("room-key", FunctionParam("room", "text")),
			FunctionParamDraft("fan-key", FunctionParam("fan", "device")),
		)
		val offer = FN_OFFER.copy(devices = listOf(DeviceOffer("plug-a", "Plug A"), DeviceOffer("plug-b", "Plug B")))
		val choices = deviceChoices(params, offer)
		val empty = ActionDraft.Filled("device_set", mapOf("device" to "", "verb" to "on"))
		val fromValue = storeDeviceChoice(empty, "device", choices.first()) as ActionDraft.Filled
		val fromPlug = storeDeviceChoice(fromValue, "device", choices.last()) as ActionDraft.Filled

		assertEquals(listOf("lamp (parameter)", "fan (parameter)", "Plug A", "Plug B"), choices.map { it.label })
		assertEquals(mapOf("device" to FunctionParamReference("lamp-key", "lamp")), fromValue.references)
		assertEquals("plug-b", fromPlug.values.getValue("device"))
		assertTrue(fromPlug.references.isEmpty())
	}

	@Test
	fun addParamNeedsAFunctionThatHoldsParamsBelowItsCap() {
		val empty = RunsView("", true, null, emptyList(), emptyList(), unique = false, makeUnique = false, unlisted = false, issue = null)
		val named = empty.copy(name = "Notify", paramsAllowed = true)
		val full = named.copy(values = (1..Protocol.Wire.FUNCTION_PARAMS_MAX).map { index ->
			ValueRow("v$index", TypeWord.Declared("text"), ValueSource.Unset, FunctionParam("v$index", "text"))
		})

		assertFalse(canAddParam(empty))
		assertTrue(canAddParam(named))
		assertFalse(canAddParam(full))
		assertFalse(canAddParam(named.copy(unlisted = true)))
	}

	@Test
	fun functionTypeWordsUseTheirDisplayLabels() {
		assertEquals(listOf("Device", "Text", "Number"), listOf("device", "text", "number").map(::functionParamTypeText))
	}

	@Test
	fun saveWaitsOnlyForWhatCannotBeWrittenAndValueLinesNeverBlock() {
		val blink = functionRow("blink", "Blink", listOf("mine"), params = listOf(FunctionParam("lamp", "device"), FunctionParam("times", "number")))
		val offer = offerOf(SANDBOX_SERVES, away = false, functions = listOf(blink, tooWarm, frost))
		val pointing = pointedAt(RunsDraft.Flat(emptyList()), "mine", blink, offer)
		fun issue(runs: RunsDraft) = runsIssue(runs, "mine", given, offer)
		fun note(runs: RunsDraft) = runsNote(runs, given, offer)
		val mistyped = pointing.copy(args = argsByName(pointing, mapOf("lamp" to SANDBOX_DEVICE, "times" to "two")))
		val set = pointing.copy(args = argsByName(pointing, mapOf("lamp" to SANDBOX_DEVICE, "times" to "3")))

		assertEquals(RunsIssue.NoSteps, issue(RunsDraft.Flat(emptyList())))
		assertNull(issue(RunsDraft.Flat(listOf(StepDraft.Action("plug", ActionDraft.Filled("device_set", mapOf("device" to SANDBOX_DEVICE, "verb" to "on")))))))
		val unknown = StepDraft.Action("unknown", ActionDraft.Unsupported(AutomationAction.Unknown("chime", buildJsonObject { put("kind", "chime") })))
		assertEquals(RunsIssue.NotAStep("unknown"), issue(RunsDraft.Pointing("new", 0L, "Chime", emptyList(), listOf(unknown), emptyMap(), AutomationAction.RunFunction(function = "new"), PointMode.NEW, null)))
		assertEquals(listOf<RunsIssue?>(null, null, null), listOf(pointing, mistyped, set).map(::issue))
		assertEquals(listOf(RunsNote.Unset("lamp"), RunsNote.BadValue("times", ValueIssue.NOT_A_NUMBER), null), listOf(pointing, mistyped, set).map(::note))
		// Clearing a shared name waits for Make unique.
		val shared = pointedAt(RunsDraft.Flat(emptyList()), "mine", tooWarm, offer).copy(name = "")
		assertEquals(RunsIssue.SharedName(2), issue(shared))
		assertNull(issue(shared.copy(mode = PointMode.UNIQUE)))
		assertNull(runsIssue(pointedAt(RunsDraft.Flat(emptyList()), "outside", frost, offer).copy(name = ""), "outside", given, offer))
	}

	@Test
	fun declaredNamesAreValidatedAndClearedParamsStayWhereUnnamedIsHeld() {
		val sole = functionRow("solo", "Solo", listOf("mine"), steps = listOf(plugStep("on")))
		val base = pointedAt(RunsDraft.Flat(emptyList()), "mine", sole, FN_OFFER)
		val older = FN_OFFER.copy(functions = FN_OFFER.functions!!.copy(served = FN_OFFER.functions!!.served.copy(unnamed = null)))
		fun issue(params: List<FunctionParam>, name: String = "Solo", offer: AutomationOffer = FN_OFFER) =
			runsIssue(base.copy(name = name, params = params.mapIndexed { index, param ->
				base.params.getOrNull(index)?.copy(param = param) ?: FunctionParamDraft("value-$index", param)
			}), "mine", given, offer)

		assertEquals(RunsIssue.BadParam("", ParamIssue.EMPTY), issue(listOf(FunctionParam("", "text"))))
		assertEquals(RunsIssue.BadParam("Lamp", ParamIssue.INVALID), issue(listOf(FunctionParam("Lamp", "text"))))
		assertEquals(RunsIssue.BadParam("lamp", ParamIssue.DUPLICATE), issue(listOf(FunctionParam("lamp", "text"), FunctionParam("lamp", "number"))))
		assertNull(issue(listOf(FunctionParam("device", "text"))))
		assertEquals(RunsIssue.TooManyParams, issue((0..Protocol.Wire.FUNCTION_PARAMS_MAX).map { FunctionParam("v$it", "text") }))
		// Params stay on an unnamed function only where the Gateway holds one.
		assertNull(issue(listOf(FunctionParam("lamp", "device")), name = ""))
		assertEquals(RunsIssue.NameWithParams, issue(listOf(FunctionParam("lamp", "device")), name = "", offer = older))
	}

	@Test
	fun listedReadsComeFirstAndUseTheActualGivenType() {
		val reads = FunctionReads(listOf("device", "reading", "lamp"), emptyList())
		val values = valueRows(listOf(FunctionParam("lamp", "device")), given, mapOf("lamp" to SANDBOX_DEVICE), "temperature", reads)

		assertEquals(listOf("device", "reading", "lamp"), values.map { it.name })
		assertEquals(listOf(ValueSource.FromTrigger, ValueSource.FromTrigger), values.take(2).map { it.source })
		assertEquals(TypeWord.Given(GivenType.TEXT), values.first().type)
	}

	@Test
	fun anUnnamedLineReadsActionStepsAsFlatRowsAndSteeringCardsByWhatTheyReach() {
		val tell = FunctionStep.Action(action = "tell_assistant", args = JsonObject(mapOf("when" to literal("now"))))
		val steps = listOf(
			FunctionStep.Switch(
				subject = "event.kind",
				cases = listOf(SwitchCase(listOf("a"), listOf(plugStep("on"), tell))),
				default = listOf(plugStep("on")),
			),
			FunctionStep.Parallel(listOf(plugStep("off"))),
			FunctionStep.Try(emptyList(), emptyList()),
			tell,
		)

		assertEquals(
			"Switch → Set device: Desk lamp, On; Tell the assistant: Now · Parallel → Set device: Desk lamp, Off · Try · Tell the assistant: Now",
			unnamedLine(steps, FN_OFFER),
		)
	}

	@Test
	fun theListNamesEachRowsFunctionAndCountsOnlyAShared() {
		val functions = listOf(tooWarm, frost)

		val own = functionRow("fn-own", "", listOf("mine"), steps = listOf(FunctionStep.If(condition = "true", steps = listOf(plugStep("on"))), plugStep("off")))
		val pointing = automationRow("own", "Every day at 06:00", listOf(AutomationAction.RunFunction(function = "fn-own")))

		assertEquals(FunctionLine.Named("Too warm", 2), functionLine(rows[0], functions, FN_OFFER))
		assertEquals(FunctionLine.Named("Frost warning", null), functionLine(rows[2], functions, FN_OFFER))
		assertNull(functionLine(rows[3], functions, FN_OFFER))
		assertEquals(FunctionLine.Unlisted, functionLine(rows[4], functions, FN_OFFER))
		assertEquals(
			FunctionLine.Unnamed("If → Set device: Desk lamp, On · Set device: Desk lamp, Off"),
			functionLine(pointing, functions + own, FN_OFFER),
		)
		assertEquals(listOf("Downstairs thermometer above 26 °C"), reachLine(tooWarm, "mine", rows))
		assertEquals("Frost warning", automationDeleteTakes(rows[2], functions))
		assertNull(automationDeleteTakes(rows[0], functions))
		assertNull(automationDeleteTakes(rows[3], functions))
	}

	@Test
	fun thePickerListsWhatThisTriggerCouldRunMostUsedFirst() {
		val blink = functionRow("blink", "Blink", listOf("a", "b"), params = listOf(FunctionParam("lamp", "device"), FunctionParam("times", "number")))
		val notify = functionRow("notify", "Notify", listOf("c", "d"), params = listOf(FunctionParam("room", "text"), FunctionParam("reading", "number")))
		val off = functionRow("off", "Everything off", listOf("e", "f", "g"))
		val github = functionRow("wake", "Wake me", listOf("h", "i", "j", "k"), reads = FunctionReads(listOf("event"), listOf("reason")))
		val asText = functionRow("text", "Says a value", listOf("l"), params = listOf(FunctionParam("reading", "text")))
		val readsDevice = functionRow("reads-device", "Device read", listOf("m"), reads = FunctionReads(listOf("device"), emptyList()))

		val picked = pickerChoices(given, listOf(blink, notify, off, github, asText, readsDevice), measure = "temperature")

		assertEquals(listOf("off", "blink", "notify", "reads-device"), picked.map { it.function.id })
		assertEquals(listOf("room" to TypeWord.Declared("text"), "reading" to TypeWord.Measure("temperature")), picked[2].signature)
		assertEquals(3, picked[0].count)
		assertEquals(listOf("device" to TypeWord.Given(GivenType.TEXT)), picked.first { it.function.id == "reads-device" }.signature)
		// Current first, invalid marked.
		val current = pickerChoices(given, listOf(off, blink.copy(invalid = "x")), measure = null, current = "blink")
		assertEquals(listOf(Triple("blink", true, "x"), Triple("off", false, null)), current.map { Triple(it.function.id, it.current, it.invalid) })
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
			SaveAnswer.Placeholder(AutomationSaveRecord.FUNCTION, "1", "message", 3L, 9L),
			saveAnswerOf(
				ConsoleAutomationSaveResult(
					stored = false,
					refusal = AutomationSaveRefusal(code = "placeholder", record = "function", path = "1", param = "message", start = 3L, end = 9L),
				),
			),
		)
		val changed = AutomationSaveRefusal(code = "changed", record = "function", revision = 5L)
		assertEquals(SaveAnswer.Refused(AutomationSaveRefusalCode.CHANGED, changed), saveAnswerOf(ConsoleAutomationSaveResult(stored = false, refusal = changed)))
		val later = AutomationSaveRefusal(code = "later_word")
		assertEquals(SaveAnswer.Refused(null, later), saveAnswerOf(ConsoleAutomationSaveResult(stored = false, refusal = later)))
	}
}
