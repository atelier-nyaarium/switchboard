package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.assistant.pointerOf
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxAutomationGatewayTest {
	private var trips = 0

	private fun gateway() = SandboxAutomationGateway(now = { 1_000_000_000L }, pause = { trips += 1 })

	private suspend fun SandboxAutomationGateway.rows(gatewayId: String) =
		(list(gatewayId).rows as ListAnswer.Listed).rows

	private suspend fun SandboxAutomationGateway.put(gatewayId: String, id: String, automation: Automation, base: Long) =
		put(gatewayId, id, automation, base, confirmed = false)

	private fun mention(tell: String = "now") = Automation(
		enabled = true,
		trigger = AutomationTrigger.Event("github", listOf(AutomationCondition("reason", "is", "mention"))),
		actions = listOf(AutomationAction.TellAssistant(tell)),
	)

	@Test
	fun aWriteLandsOnlyOverTheRevisionItReadAndSurvivesTheReadAfterIt() = runBlocking {
		val gateway = gateway()
		val before = gateway.rows("sandbox").map { it.id }

		val added = gateway.put("sandbox", "new", mention(), 0L)
		val stale = gateway.put("sandbox", "new", mention("quietly"), 0L)
		val edited = gateway.put("sandbox", "new", mention("quietly"), 1L)

		assertEquals(listOf(false, 1L), listOf(stale.stored, stale.row?.revision))
		assertEquals(listOf(true, 2L), listOf(edited.stored, edited.revision))
		assertEquals(before + "new", gateway.rows("sandbox").map { it.id })
		assertEquals(false, gateway.delete("sandbox", "new", 1L).deleted)
		assertEquals(true, gateway.delete("sandbox", "new", 2L).deleted)
		assertEquals(before, gateway.rows("sandbox").map { it.id })
		// One shelf per Gateway.
		assertEquals(before, gateway.rows("another").map { it.id })
	}

	@Test
	fun aCheckAndSaveShareARefusalAndTheCheckLeavesTheListingUnchanged() = runBlocking {
		val gateway = gateway()
		val before = gateway.list("sandbox")
		val held = gateway.rows("sandbox").single { it.id == "evening" }
		val save = ConsoleOp.AutomationSave(
			automationId = held.id,
			automation = held.automation,
			automationBase = held.revision - 1L,
			confirmed = true,
		)
		val check = ConsoleOp.AutomationCheck(
			automationId = save.automationId,
			automation = save.automation,
			automationBase = save.automationBase,
			confirmed = true,
		)

		val checked = gateway.check("sandbox", check)!!
		val saved = gateway.save("sandbox", save)

		assertEquals(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, checked.refusal?.code)
		assertEquals(checked.refusal, saved.refusal)
		assertEquals(before, gateway.list("sandbox"))
	}

	@Test
	fun aFunctionMovedDuringCheckCanBeSavedAgainstItsNewRevision() = runBlocking {
		val gateway = gateway()
		val lamp = gateway.rows("sandbox").single { pointerOf(it.automation) == SANDBOX_MOVING_FUNCTION }
		val shown = gateway.list("sandbox").functions.orEmpty().single { it.id == SANDBOX_MOVING_FUNCTION }
		val previousSteps = written(shown.function)
		val save = ConsoleOp.AutomationSave(
			automationId = lamp.id,
			automation = lamp.automation,
			automationBase = lamp.revision,
			functionBase = shown.revision,
			confirmed = true,
		)
		val check = ConsoleOp.AutomationCheck(
			automationId = save.automationId,
			automation = save.automation,
			automationBase = save.automationBase,
			functionBase = save.functionBase,
			confirmed = true,
		)

		val refused = gateway.check("sandbox", check)!!
		val changed = gateway.list("sandbox").functions.orEmpty().single { it.id == SANDBOX_MOVING_FUNCTION }
		val again = gateway.check("sandbox", check.copy(functionBase = changed.revision))!!
		val saved = gateway.save("sandbox", save.copy(functionBase = changed.revision))

		assertEquals(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, refused.refusal?.code)
		assertEquals(Protocol.Wire.AutomationSaveRecord.FUNCTION.wire, refused.refusal?.record)
		assertEquals(shown.revision + 1L, changed.revision)
		assertNotEquals(previousSteps, written(changed.function))
		assertTrue(again.ready)
		assertTrue(saved.stored)
		assertEquals(lamp.revision + 1L, saved.automation?.revision)
	}

	@Test
	fun aSensorsCrossingTakesAWriteAndADeleteLikeAnyOther() = runBlocking {
		val gateway = gateway()
		val crossing = gateway.rows("sandbox").first { (it.automation.trigger as? AutomationTrigger.Crossing)?.device == SANDBOX_SENSOR }

		val off = gateway.put("sandbox", crossing.id, crossing.automation.copy(enabled = false), crossing.revision)
		assertEquals(true, off.stored)
		assertEquals(true, gateway.delete("sandbox", crossing.id, off.revision).deleted)
	}

	@Test
	fun theSecondGatewayRefusesAsAnOlderBuildTheEmptyOneListsNoneAndEveryCallTakesARoundTrip() = runBlocking {
		val gateway = gateway()

		assertEquals(AutomationListing(ListAnswer.NotServed), gateway.list(SECOND_SANDBOX_GATEWAY))
		assertEquals(false, gateway.put(SECOND_SANDBOX_GATEWAY, "new", mention(), 0L).stored)
		assertNull(gateway.preview(SECOND_SANDBOX_GATEWAY, ConsoleOp.AutomationPreview(trigger = mention().trigger)))
		assertEquals(ListAnswer.Listed(emptyList<Any>()), gateway.list(EMPTY_GATEWAY).rows)
		assertEquals(ListAnswer.Unreachable, gateway.list(SANDBOX_NEVER_REGISTERED).rows)
		assertEquals(1L, gateway.preview("sandbox", ConsoleOp.AutomationPreview(trigger = mention().trigger))?.matched)
		assertEquals(6, trips)
	}

	@Test
	fun aDangerousActionAsksOnceAndATextIsFilledFromTheTriggersNamesOrRefusedAtItsHole() = runBlocking {
		val gateway = gateway()
		val posts = mention().copy(actions = listOf(AutomationAction.IftttTrigger("door")))
		val evening = AutomationTrigger.Time("18:00", listOf(1L), "America/Los_Angeles")

		val asked = gateway.put("sandbox", "posts", posts, 0L)
		val agreed = gateway.put("sandbox", "posts", posts, 0L, confirmed = true)
		val toggled = gateway.put("sandbox", "posts", posts.copy(enabled = false), 1L)
		val filled = gateway.preview("sandbox", ConsoleOp.AutomationPreview(trigger = evening, text = "It is {time}."))
		val refused = gateway.preview("sandbox", ConsoleOp.AutomationPreview(trigger = evening, text = "It is {value}."))

		assertEquals(listOf("Send to IFTTT"), asked.confirm)
		assertEquals(listOf(true, true), listOf(agreed.stored, toggled.stored))
		assertEquals("It is 18:00.", filled?.filled)
		assertEquals(listOf(6L, 13L), listOf(refused?.hole?.start, refused?.hole?.end))
	}

	@Test
	fun functionRowsCarryWhatTheirStepsReadAndOneGatewayHoldsNone() = runBlocking {
		val gateway = gateway()
		val rows = gateway.list("sandbox").functions.orEmpty().associateBy { it.id }
		val idle = gateway.list(EMPTY_GATEWAY)

		assertEquals(listOf("value"), rows.getValue("too-warm").reads.names)
		assertEquals(listOf("lamp", "message"), rows.getValue("blink").reads.names)
		assertEquals(false, rows.getValue("too-warm").moves)
		// Today's road.
		assertEquals(listOf(null, null), listOf(idle.serves?.functions, idle.functions))
	}

	@Test
	fun theSandboxShowsOwnerUnitsAndPreviewFillsAFunctionValue() = runBlocking {
		val gateway = gateway()
		val preview = gateway.preview(
			"sandbox",
			ConsoleOp.AutomationPreview(
				trigger = AutomationTrigger.Time("18:00", emptyList(), "UTC"),
				text = "Good {message}",
				params = listOf(FunctionParam("message", "text")),
				values = buildJsonObject { put("message", "evening") },
			),
		)
		val warmHall = gateway.rows("sandbox").single { it.id == "warm-hall" }
		val temperature = gateway.preview("sandbox", ConsoleOp.AutomationPreview(trigger = warmHall.automation.trigger, text = "It is {value}."))
		val previewValue = temperature?.names?.single { it.name == "value" }?.shown

		assertEquals("Good evening", preview?.filled)
		assertEquals("35.2 °F", previewValue)
		assertEquals("It is 35.2 °F.", temperature?.filled)
		assertEquals(previewValue?.takeLast(2), warmHall.sentence.takeLast(2))
	}

	@Test
	fun aFunctionEditThatLeavesAnotherUserUnfitSavesAndThatUserCountsAnError() = runBlocking {
		val gateway = gateway()
		val warm = gateway.rows("sandbox").single { it.id == "warm-room" }
		val body = AutomationFunction(
			"Too warm",
			listOf(FunctionParam("room", "text")),
			listOf(FunctionStep.Do(action = "tell_assistant", args = JsonObject(mapOf("when" to literal("now"), "message" to literal("It is {room}."))))),
		)
		val answer = gateway.save(
			"sandbox",
			ConsoleOp.AutomationSave(
				automationId = warm.id,
				automation = warm.automation,
				automationBase = warm.revision,
				function = AutomationSaveFunction.Edit("too-warm", body, 2L),
			),
		)

		assertTrue(answer.stored)
		assertEquals(1L, gateway.rows("sandbox").single { it.id == "warm-hall" }.errors)
	}

	@Test
	fun droppingFunctionParamsAndSavingAClockPreservesItsNextRun() = runBlocking {
		val gateway = gateway()
		val blink = gateway.rows("sandbox").single { it.id == "blink-evening" }
		val withoutValues = AutomationFunction(
			"Blink",
			emptyList(),
			listOf(FunctionStep.Do(action = "tell_assistant", args = JsonObject(mapOf("when" to literal("now"), "message" to literal("Done"))))),
		)
		val functionAnswer = gateway.save(
			"sandbox",
			ConsoleOp.AutomationSave(
				automationId = blink.id,
				automation = blink.automation,
				automationBase = blink.revision,
				function = AutomationSaveFunction.Edit("blink", withoutValues, 1L),
			),
		)
		val clock = gateway.rows("sandbox").single { it.id == "evening" }
		val clockAnswer = gateway.save(
			"sandbox",
			ConsoleOp.AutomationSave(
				automationId = clock.id,
				automation = clock.automation,
				automationBase = clock.revision,
			),
		)

		assertTrue(functionAnswer.stored)
		assertEquals(emptyList<FunctionParam>(), functionAnswer.function?.function?.params)
		assertEquals(clock.nextRunAt, clockAnswer.automation?.nextRunAt)
	}

	@Test
	fun aUniqueFunctionCopyKeepsTheNameChosenOnThePhone() = runBlocking {
		val gateway = gateway()
		val warm = gateway.rows("sandbox").single { it.id == "warm-room" }
		val source = gateway.list("sandbox").functions.orEmpty().single { it.id == "too-warm" }
		val copy = source.function.copy(name = "Too warm.001")
		val save = ConsoleOp.AutomationSave(
			automationId = warm.id,
			automation = warm.automation,
			automationBase = warm.revision,
			function = AutomationSaveFunction.Copy(source.id, source.revision, copy),
		)
		val before = gateway.list("sandbox")
		val checks = List(2) {
			gateway.check("sandbox", ConsoleOp.AutomationCheck(save.automationId, save.automation, save.automationBase, function = save.function, confirmed = true))
		}
		val untouched = gateway.list("sandbox")
		val answer = gateway.save("sandbox", save)

		assertEquals(listOf(true, true), checks.map { it?.ready })
		assertEquals(before, untouched)
		assertEquals("copy-1", answer.function?.id)
		assertTrue(answer.stored)
		assertEquals("Too warm.001", answer.function?.function?.name)
		assertTrue(gateway.list("sandbox").functions.orEmpty().any { it.function.name == "Too warm.001" })
	}

	@Test
	fun aMissingFunctionOrADangerRefusesWhileAHoleOrAFitIsAnIssue() = runBlocking {
		val gateway = gateway()
		val warm = gateway.rows("sandbox").single { it.id == "warm-room" }
		suspend fun save(automation: Automation, function: AutomationSaveFunction? = null) =
			gateway.save("sandbox", ConsoleOp.AutomationSave(automationId = warm.id, automation = automation, automationBase = warm.revision, function = function)).refusal
		suspend fun check(automation: Automation, function: AutomationSaveFunction? = null) =
			gateway.check("sandbox", ConsoleOp.AutomationCheck(automationId = warm.id, automation = automation, automationBase = warm.revision, function = function))!!
		fun body(action: String, vararg args: Pair<String, String>) =
			AutomationFunction("Too warm", emptyList(), listOf(FunctionStep.Do(action = action, args = JsonObject(args.associate { (name, text) -> name to literal(text) }))))

		assertEquals("unknown_function", save(warm.automation.copy(actions = listOf(AutomationAction.RunFunction(function = "gone"))))?.code)
		val hole = check(warm.automation, AutomationSaveFunction.Edit("too-warm", body("tell_assistant", "when" to "now", "message" to "It is {nope}."), 2L))
		assertEquals(true, hole.ready)
		assertEquals(listOf("error", "too-warm", "0", "message"), hole.issues!!.single { it.record == "function" }.let { listOf(it.level, it.id, it.step, it.param) })
		val clocked = check(warm.automation.copy(trigger = AutomationTrigger.Time("18:00", listOf(1L), "UTC")))
		assertEquals(listOf(true, "automation"), listOf(clocked.ready, clocked.issues!!.single().record))
		val ifttt = save(warm.automation, AutomationSaveFunction.Edit("too-warm", body("ifttt_trigger", "event" to "door"), 2L))
		assertEquals(listOf("Send to IFTTT"), ifttt?.labels)
	}

	@Test
	fun aSaveWhoseTextNamesNothingHereIsRefusedAtItsHoleAndStoresNothing() = runBlocking {
		val gateway = gateway()
		val told = { message: String -> mention().copy(actions = listOf(AutomationAction.TellAssistant("now"), AutomationAction.TellAssistant("now", message))) }

		val refused = gateway.put("sandbox", "told", told("It is {nope}."), 0L)
		val kept = gateway.put("sandbox", "told", told("About {event}."), 0L)

		assertEquals(listOf(false, 1L, "message", 6L, 12L), listOf(refused.stored, refused.hole?.action, refused.hole?.param, refused.hole?.start, refused.hole?.end))
		assertEquals(listOf(true, 1L), listOf(kept.stored, kept.revision))
	}
}
