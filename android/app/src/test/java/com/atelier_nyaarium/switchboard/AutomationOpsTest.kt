package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationCheckResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationRunResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptParseResult
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptPrintResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.IntervalUnit
import com.atelier_nyaarium.switchboard.assistant.TextRef
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationPlaceholderSpan
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import kotlinx.serialization.json.JsonObject
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.FunctionOffer
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.functionPreviewScopeOf
import com.atelier_nyaarium.switchboard.assistant.previewAsk
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.runShown
import com.atelier_nyaarium.switchboard.assistant.pointedTo
import com.atelier_nyaarium.switchboard.assistant.Slot
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.stepOfDraft
import com.atelier_nyaarium.switchboard.assistant.refusedPlaceholderOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun automation(
	enabled: Boolean = true,
	conditions: List<AutomationCondition> = emptyList(),
) = Automation(
	enabled = enabled,
	trigger = AutomationTrigger.Event(source = "github", conditions = conditions),
	actions = listOf(AutomationAction.TellAssistant("now")),
)

private fun automationRow(
	id: String = "review",
	revision: Long = 1L,
	automation: Automation = automation(),
	sentence: String = "GitHub: review requested",
) = AutomationRow(id = id, revision = revision, automation = automation, sentence = sentence)

private val SERVES = AutomationServes(
	triggers = SANDBOX_SERVES.triggers.filter { it.kind in setOf("event", "interval") },
	actions = SANDBOX_SERVES.actions.filter { it.kind == "tell_assistant" },
	numbers = emptyList(),
	devices = emptyList(),
)


private val HERE = EditContext(tellOnlyOffer(), emptyList())

class AutomationOpsTest {
	private class FakeGateway : AutomationGateway {
		val shelves = mutableMapOf<String, List<AutomationRow>>()
		val refusing = mutableSetOf<String>()
		var serves = SERVES
		val unreachable = mutableSetOf<String>()
		val holds = mutableMapOf<String, TestHold>()
		val putHolds = mutableMapOf<String, TestHold>()
		val puts = mutableListOf<Triple<String, String, Long>>()
		val confirmed = mutableListOf<Boolean>()
		/** Answered in place of a write. */
		val answers = ArrayDeque<ConsoleAutomationPutResult>()
		var deletes = 0
		val previews = mutableListOf<Triple<String?, List<FunctionParam>?, JsonObject?>>()
		val functionRows = mutableListOf<AutomationFunctionRow>()
		val checks = mutableListOf<ConsoleOp.AutomationCheck>()
		var checkAnswer: ConsoleAutomationCheckResult? = ConsoleAutomationCheckResult(ready = true)

		val runCalls = mutableListOf<Pair<String, String>>()
		var runAnswer: AutomationRan = AutomationRan.Started
		var listCalls = 0

		override suspend fun run(gatewayId: String, automationId: String, callId: String): AutomationRan {
			runCalls += automationId to callId
			return runAnswer
		}

		override suspend fun scriptPrint(gatewayId: String, op: ConsoleOp.ScriptPrint): ConsoleScriptPrintResult? = null

		override suspend fun scriptParse(gatewayId: String, op: ConsoleOp.ScriptParse): ConsoleScriptParseResult? = null

		override suspend fun scriptVocabulary(gatewayId: String): com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult? = null

		override suspend fun list(gatewayId: String): AutomationListing {
			listCalls++
			val listed = shelves[gatewayId].orEmpty()
			holds.remove(gatewayId)?.pass()
			if (gatewayId in refusing) return AutomationListing(ListAnswer.NotServed)
			if (gatewayId in unreachable) throw IllegalStateException("unreachable")
			return AutomationListing(ListAnswer.Listed(listed), serves, functions = functionRows.takeIf { it.isNotEmpty() })
		}

		override suspend fun put(
			gatewayId: String,
			automationId: String,
			automation: Automation,
			baseRevision: Long,
			confirmed: Boolean,
		): ConsoleAutomationPutResult {
			putHolds.remove(gatewayId)?.pass()
			this.confirmed += confirmed
			answers.removeFirstOrNull()?.let { return it }
			puts += Triple(gatewayId, automationId, baseRevision)
			val held = shelves[gatewayId].orEmpty().find { it.id == automationId }
			if ((held?.revision ?: 0L) != baseRevision) {
				return ConsoleAutomationPutResult(
					stored = false,
					revision = held?.revision ?: 0L,
					row = held,
					reason = "the held revision differs",
				)
			}
			val stored = automationRow(
				id = automationId,
				revision = baseRevision + 1L,
				automation = automation,
				sentence = held?.sentence ?: "GitHub: review requested",
			)
			shelves[gatewayId] = shelves[gatewayId].orEmpty().filterNot { it.id == automationId } + stored
			return ConsoleAutomationPutResult(stored = true, revision = stored.revision, row = stored)
		}

		override suspend fun delete(gatewayId: String, automationId: String, baseRevision: Long): ConsoleAutomationDeleteResult {
			deletes += 1
			val held = shelves[gatewayId].orEmpty().find { it.id == automationId }
			if (held?.revision != baseRevision) return ConsoleAutomationDeleteResult(deleted = false, reason = "stale")
			shelves[gatewayId] = shelves[gatewayId].orEmpty().filterNot { it.id == automationId }
			return ConsoleAutomationDeleteResult(deleted = true)
		}

		override suspend fun preview(gatewayId: String, ask: ConsoleOp.AutomationPreview): ConsoleAutomationPreviewResult? {
			previews += Triple(ask.text, ask.params, ask.args)
			return ConsoleAutomationPreviewResult(matched = 1L, of = 3L, matches = emptyList(), filled = ask.text)
		}

		val saves = mutableListOf<ConsoleOp.AutomationSave>()

		override suspend fun save(gatewayId: String, op: ConsoleOp.AutomationSave): ConsoleAutomationSaveResult {
			saves += op
			val stored = automationRow(id = op.automationId, revision = op.automationBase + 1L, automation = op.automation)
			shelves[gatewayId] = shelves[gatewayId].orEmpty().filterNot { it.id == op.automationId } + stored
			return ConsoleAutomationSaveResult(stored = true, automation = stored)
		}

		override suspend fun check(gatewayId: String, op: ConsoleOp.AutomationCheck): ConsoleAutomationCheckResult? {
			checks += op
			return checkAnswer
		}
	}

	private class Host(override val gateway: AutomationGateway?) : AutomationHost

	/** Counts the writes made while the move lock is held. */
	private class LockingHost(private val fake: FakeGateway) : AutomationHost {
		override val gateway: AutomationGateway = fake
		var writes = 0

		var home = "sakura"

		override suspend fun carried(gatewayId: String, write: suspend () -> Unit): Boolean {
			if (gatewayId != home) return false
			val before = fake.puts.size + fake.deletes
			write()
			writes += fake.puts.size + fake.deletes - before
			return true
		}
	}

	@Test
	fun anEventAutomationsWriteRunsUnderTheMoveLockAndAnyOtherGoesStraightToItsGateway() = runBlocking {
		val fake = FakeGateway().apply { shelves["sakura"] = listOf(automationRow()) }
		val host = LockingHost(fake)
		val ops = AutomationOps(admitting("sakura", "mikan"), host)
		val hourly = automation().copy(trigger = AutomationTrigger.Interval(60L))

		ops.save("sakura", "new", automation(), 0L, stored = null)
		ops.setEnabled("sakura", automationRow(), false)
		ops.delete("sakura", "new", 1L, automation())
		host.home = "mikan"
		val moved = listOf(
			ops.save("sakura", "late", automation(), 0L, stored = null),
			ops.setEnabled("sakura", automationRow(), true),
			ops.delete("sakura", "review", 2L, automation()),
			ops.save("sakura", "review", hourly, 2L, stored = automation()),
		)
		val sent = fake.deletes
		val missing = ops.delete("sakura", "nope", 1L, hourly) to fake.deletes - sent
		// Never read; stored body decides.
		val unread = AutomationOps(admitting("sakura"), host)
		val blind = listOf(unread.save("sakura", "review", hourly, 2L, stored = automation()), unread.delete("sakura", "gone", 1L, hourly))
		val stays = listOf(
			ops.save("sakura", "hourly", hourly, 0L, stored = null),
			ops.setEnabled("sakura", automationRow("hourly", 1L, hourly), false),
			ops.delete("sakura", "hourly", 2L, hourly),
		)

		assertEquals(3, host.writes)
		assertEquals(List(4) { AutomationSaved.Refused(HOME_MOVED) }, moved)
		assertEquals(AutomationSaved.Refused("stale") to 1, missing)
		assertEquals(listOf(AutomationSaved.Refused(HOME_MOVED), AutomationSaved.Refused("stale")), blind)
		assertEquals(listOf(true, true, true), stays.map { it is AutomationSaved.Stored })
	}

	@Test
	fun aFunctionWriteLocksAtHomeWhenItsListedRowIsMissing() {
		val pointer = Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("held")))
		val event = pointer.copy(trigger = AutomationTrigger.Event("github", emptyList()))
		val listed = functionRow("held", "Held", listOf("clock"))
		val noMoves = FunctionOffer(SANDBOX_SERVES.functions!!, listOf(listed))
		val moves = FunctionOffer(SANDBOX_SERVES.functions!!, listOf(listed.copy(moves = true)))

		assertTrue(functionWriteMoves(listOf(pointer), "sakura", "sakura", null))
		assertFalse(functionWriteMoves(listOf(pointer), "mikan", "sakura", null))
		assertFalse(functionWriteMoves(listOf(pointer), "sakura", "sakura", noMoves))
		assertTrue(functionWriteMoves(listOf(pointer), "sakura", "sakura", moves))
		assertTrue(functionWriteMoves(listOf(event), "mikan", "sakura", null))
	}

	@Test
	fun anEditorStandsOnWhatIsStoredNotOnWhatIsTyped() {
		val fake = FakeGateway().apply { shelves["sakura"] = listOf(automationRow()) }
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		runBlocking { ops.refresh("sakura") }
		val hourly = automationRow("hourly", 1L, automation().copy(trigger = AutomationTrigger.Interval(60L)))
		val toEvent: (AutomationDraft) -> AutomationDraft = { it.copy(trigger = TriggerDraft.Event("github", emptyList())) }
		val toClock: (AutomationDraft) -> AutomationDraft = { it.copy(trigger = TriggerDraft.Interval("1", IntervalUnit.HOURS)) }
		fun typed(slot: AutomationSlot, opened: AutomationDraft, change: (AutomationDraft) -> AutomationDraft): AutomationDraftKey {
			val key = AutomationDraftKey("sakura", slot)
			ops.edits.show(key)
			ops.edits.edit(key, ops.edits.open(key, opened)!!, change)
			ops.edits.hide()
			return key
		}

		val clock = typed(AutomationSlot.Held("hourly"), automationDraftOf(hourly, HERE)!!, toEvent)
		val event = typed(AutomationSlot.Held("review"), automationDraftOf(automationRow(), HERE)!!, toClock)
		val fresh = typed(AutomationSlot.New(), automationDraftOf(hourly, HERE)!!.copy(original = null), toEvent)

		assertEquals(listOf(false, true, false), listOf(clock, event, fresh).map(ops::editsEvent))
		ops.edits.clear()
		assertTrue(ops.editsEvent(event))
	}

	@Test
	fun aGoAheadIsDroppedOnceTheDraftChangesAndAPlainRefusalStays() = runBlocking {
		val fake = FakeGateway()
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(), HERE)!!)!!
		val said = { ops.edits.state.value.held.getValue(key).said }

		fake.answers += ConsoleAutomationPutResult(false, 0L, reason = "confirm", confirm = listOf("Send to IFTTT"))
		fake.answers += ConsoleAutomationPutResult(false, 0L, reason = "no")
		ops.commit(key, shown, confirmed = false)
		ops.edits.edit(key, shown) { draft -> draft.copy(text = TextRef(draft.steps[0].key, "message")) }
		val kept = said()
		ops.edits.edit(key, shown) { draft -> draft.withAction(draft.steps[0].key) { toldDraft("quietly") } }
		val dropped = said()
		ops.commit(key, shown, confirmed = false)
		ops.edits.edit(key, shown) { draft -> draft.withAction(draft.steps[0].key) { toldDraft("now") } }

		assertEquals(AutomationSaid.Confirm(listOf("Send to IFTTT")), kept)
		assertNull(dropped)
		assertEquals(AutomationSaid.Line("no"), said())
	}

	@Test
	fun aListingSaysWhatItsGatewayHoldsAndARefusedSaveCarriesWhatToAskAndWhereAPlaceholderFailed() = runBlocking {
		val fake = FakeGateway().apply { shelves["sakura"] = emptyList() }
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		fake.answers += ConsoleAutomationPutResult(false, 0L, reason = "confirm", confirm = listOf("Send to IFTTT"))
		fake.answers += ConsoleAutomationPutResult(false, 0L, reason = "no name x here", placeholder =AutomationPlaceholderSpan(0L, "message", 3L, 6L))

		val asks = ops.save("sakura", "new", automation(), 0L, stored = null) as AutomationSaved.Refused
		val placeholder = ops.save("sakura", "new", automation(), 0L, stored = null) as AutomationSaved.Refused
		ops.save("sakura", "new", automation(), 0L, stored = null, confirmed = true)

		assertEquals(SERVES, state.value.gateways.entry("sakura")?.automationServes)
		assertEquals(listOf("Send to IFTTT"), asks.confirm)
		assertEquals(refusedPlaceholderOf(AutomationPlaceholderSpan(0L, "message", 3L, 6L)), placeholder.placeholder)
		assertEquals(listOf(false, false, true), fake.confirmed)
	}

	private fun admitting(vararg ids: String) = MutableStateFlow(ChatState(gateways = testRegistry(*ids)))

	private fun ChatState.drawn() = gateways.gateways.filter { it.automations is GatewayList.Listed }.map { it.id }

	@Test
	fun listedGatewaysAreDrawnWhileRefusalHidesAndUnreachableKeepsTheLastList() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow())
		fake.refusing += "old-box"
		val state = admitting("sakura", "old-box")
		val ops = AutomationOps(state, Host(fake))

		runBlocking { ops.refreshAll() }
		assertEquals(listOf("sakura"), state.value.drawn())
		assertEquals("review", state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.id)

		fake.unreachable += "sakura"
		runBlocking { ops.refreshAll() }
		assertEquals("review", state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.id)

		fake.unreachable -= "sakura"
		fake.refusing += "sakura"
		runBlocking { ops.refreshAll() }
		assertTrue(state.value.drawn().isEmpty())
	}

	@Test
	fun anOlderReadCannotRestoreTheListItReadBeforeANewerOne() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(sentence = "Old"))
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))
		val hold = TestHold()
		fake.holds["sakura"] = hold

		val older = launch { ops.refresh("sakura") }
		hold.entered.await()
		fake.shelves["sakura"] = listOf(automationRow(sentence = "New"))
		ops.refresh("sakura")
		assertEquals("New", state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.sentence)
		hold.gate.complete(Unit)
		older.join()

		assertEquals("New", state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.sentence)
	}

	@Test
	fun aReadForARemovedGatewayCannotLand() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["mikan"] = listOf(automationRow())
		val state = admitting("mikan")
		val ops = AutomationOps(state, Host(fake))
		val hold = TestHold()
		fake.holds["mikan"] = hold

		val slow = launch { ops.refresh("mikan") }
		hold.entered.await()
		state.value = state.value.copy(gateways = testRegistry())
		hold.gate.complete(Unit)
		slow.join()

		assertTrue(state.value.gateways.gateways.isEmpty())
	}

	@Test
	fun aRefusedToggleKeepsItsReasonUntilAStoredToggleAndUsesTheHeldRevision() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 3L))
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))
		runBlocking { ops.refreshAll() }

		val stale = runBlocking { ops.setEnabled("sakura", automationRow(revision = 2L), false) }
		assertEquals("the held revision differs", (stale as AutomationSaved.Refused).reason)
		assertEquals("the held revision differs", ops.toggles.refusalFor("sakura", "review"))
		assertEquals(true, state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.automation?.enabled)

		val current = state.value.gateways.entry("sakura")!!.automations.listedRows()!!.single()
		assertTrue(runBlocking { ops.setEnabled("sakura", current, false) } is AutomationSaved.Stored)
		assertNull(ops.toggles.refusalFor("sakura", "review"))
		assertEquals(false, state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.automation?.enabled)
		assertEquals(listOf(2L, 3L), fake.puts.map { it.third })
	}

	@Test
	fun anOlderToggleRefusalCannotReplaceANewerToggleAnswer() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 2L))
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val hold = TestHold()
		fake.putHolds["sakura"] = hold

		val older = launch { ops.setEnabled("sakura", automationRow(revision = 1L), false) }
		hold.entered.await()
		val row = state.value.gateways.entry("sakura")!!.automations.listedRows()!!.single()
		assertTrue(ops.setEnabled("sakura", row, false) is AutomationSaved.Stored)
		hold.gate.complete(Unit)
		older.join()

		assertNull(ops.toggles.refusalFor("sakura", "review"))
		assertEquals(false, state.value.gateways.entry("sakura")?.automations?.listedRows()?.single()?.automation?.enabled)
	}

	@Test
	fun saveRefusalCarriesTheNewerHeldRowAndEveryMutationRefreshes() {
		val fake = FakeGateway()
		val newer = automationRow(revision = 5L)
		fake.shelves["sakura"] = listOf(newer)
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))

		val refused = runBlocking { ops.save("sakura", "review", automation(), 3L, stored = automation()) } as? AutomationSaved.Refused
		assertEquals(newer, refused?.heldRow)
		assertEquals("the held revision differs", refused?.reason)
		assertEquals(newer, state.value.gateways.entry("sakura")?.automations?.listedRows()?.single())

		assertTrue(runBlocking { ops.save("sakura", "new", automation(), 0L, stored = null) } is AutomationSaved.Stored)
		assertEquals(listOf(3L, 0L), fake.puts.map { it.third })
	}

	@Test
	fun deleteUsesTheGatewaysAnswerAndPreviewReturnsItsListing() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow())
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		runBlocking { ops.refresh("sakura") }

		assertEquals(AutomationSaved.Stored(null), runBlocking { ops.delete("sakura", "review", 1L, automation()) })
		assertEquals(1L, runBlocking { ops.preview("sakura", ConsoleOp.AutomationPreview(trigger = automation().trigger)) }?.matched)
	}

	@Test
	fun aRunByHandIsHeldForItsOpeningJoinsAnUnansweredTapAndReadsTheListOnlyWhenItStarts() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow())
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val key = RunKey("sakura", "review")

		fake.runAnswer = AutomationRan.Unreachable
		ops.run("sakura", "review", 1L)
		fake.runAnswer = AutomationRan.Started
		assertEquals(AutomationRan.Started, ops.run("sakura", "review", 1L))
		assertEquals(1, fake.listCalls)
		fake.runAnswer = AutomationRan.Refused(Protocol.Wire.AutomationRunRefusal.OFF)
		ops.run("sakura", "review", 2L)

		val ids = fake.runCalls.map { it.second }
		assertEquals(listOf(true, false), listOf(ids[0] == ids[1], ids[1] == ids[2]))
		assertEquals(1, fake.listCalls)
		assertEquals(listOf(null, "Turn it on to run it."), listOf(1L, 2L).map { runShown(ops.runs.value[key], it) })
		assertEquals(AutomationRan.Refused(null), ranOf(ConsoleAutomationRunResult(ran = false, refusal = "newer_reason")))
	}

	@Test
	fun aTextPlaceholderPreviewReceivesTheFunctionArgs() = runBlocking {
		val function = functionRow("notice", "Notice", listOf("review"), params = listOf(FunctionParam("room", "text")))
		val functions = AutomationFunctionServes(32L, listOf("tell_assistant"), listOf("device", "text", "number"))
		val offer = offerOf(SERVES.copy(functions = functions), away = false, functions = listOf(function))
		val pointer = Automation(enabled = true, trigger = automation().trigger, actions = listOf(AutomationAction.RunFunction(
			"notice",
			args = buildJsonObject { put("room", "Bedroom") },
		)))
		val draft = automationDraftOf(automationRow(automation = pointer), EditContext(offer, emptyList()))!!
		val scope = functionPreviewScopeOf(draft.runsDraft())!!
		val fake = FakeGateway()
		val ops = AutomationOps(admitting("sakura"), Host(fake))

		ops.preview("sakura", previewAsk(pointer.trigger, "We are in {room}.", scope)!!)

		assertEquals(
			Triple("We are in {room}.", listOf(FunctionParam("room", "text")), buildJsonObject { put("room", "Bedroom") }),
			fake.previews.single(),
		)
	}

	@Test
	fun checkUsesTheSavePayloadAndAlwaysConfirmsIt() = runBlocking {
		val fake = FakeGateway()
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val save = ConsoleOp.AutomationSave(
			automationId = "review",
			automation = automation(),
			automationBase = 4L,
			functionBase = 7L,
			confirmed = false,
		)
		val body = AutomationFunction("Notice", emptyList(), listOf(plugStep("on")))
		val writing = save.copy(function = AutomationSaveFunction.Edit("notice", body, 3L), functionBase = null)

		assertEquals(ConsoleAutomationCheckResult(ready = true), ops.check("sakura", save))
		ops.check("sakura", writing)
		assertEquals(
			listOf(
				ConsoleOp.AutomationCheck("review", save.automation, 4L, functionBase = 7L, confirmed = true),
				ConsoleOp.AutomationCheck("review", save.automation, 4L, function = writing.function, confirmed = true),
			),
			fake.checks,
		)
	}

	@Test
	fun aReloadThatReadsNothingNewerKeepsTheDraftAndStillSaysChanged() = runBlocking {
		val fake = FakeGateway().apply { serves = SANDBOX_SERVES }
		val function = functionRow("notice", "Notice", listOf("review"), steps = listOf(plugStep("on")))
		fake.functionRows += function
		val owner = automationRow(
			"review",
			1L,
			Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("notice"))),
		)
		fake.shelves["sakura"] = listOf(owner)
		val state = admitting("sakura")
		state.value = state.value.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null))
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(function)), emptyList())
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val draft = automationDraftOf(owner, context)!!
		val opening = ops.edits.open(key, draft)!!

		ops.reloadFunction(key, opening, "notice")
		val session = ops.edits.state.value.held.getValue(key)

		assertEquals(draft, session.draft)
		assertEquals(AutomationSaid.FunctionChanged("notice"), session.said)
		assertEquals(1, state.value.notices.size)
	}

	@Test
	fun reloadFunctionUsesTheFreshListingAndReplacesTheBody() = runBlocking {
		val fake = FakeGateway().apply { serves = SANDBOX_SERVES }
		val oldFunction = functionRow("notice", "Old", listOf("review"), steps = listOf(plugStep("on")))
		val nextFunction = oldFunction.copy(
			revision = 4L,
			function = AutomationFunction("Changed", emptyList(), listOf(plugStep("off"))),
		)
		fake.functionRows += oldFunction
		val owner = automationRow(
			"review",
			1L,
			Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("notice"))),
		)
		fake.shelves["sakura"] = listOf(owner)
		val state = admitting("sakura")
		state.value = state.value.copy(
			assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null),
		)
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(oldFunction)), emptyList())
		val draft = automationDraftOf(owner, context)!!
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val opening = ops.edits.open(key, draft)!!
		ops.edits.edit(key, opening) { held ->
			val runs = held.runsDraft() as RunsDraft.Pointing
			held.withRuns(runs.copy(name = "Typed"))
		}
		fake.functionRows.clear()
		fake.functionRows += nextFunction

		val result = ops.reloadFunction(key, opening, "notice")
		val session = ops.edits.state.value.held.getValue(key)
		val landed = session.draft.runsDraft() as RunsDraft.Pointing

		assertTrue(result is EditOutcome.Stays)
		assertEquals(4L to "Changed", landed.base to landed.name)
		assertEquals(listOf(plugStep("off")), landed.steps.map { stepOfDraft(it, context.offer, landed.params, listed(context.offer)) })
		assertTrue(session.said is AutomationSaid.Note)
		ops.edits.edit(key, opening) { it.copy(enabled = !it.enabled) }
		assertEquals(null, ops.edits.state.value.held.getValue(key).said)
	}

	@Test
	fun reloadingAChangedCalleeReplacesThatCalleeAloneAndSaysItsEditsWereDropped() = runBlocking {
		val fake = FakeGateway().apply { serves = SANDBOX_SERVES }
		val chime = functionRow("chime", "Chime", emptyList(), steps = listOf(plugStep("on"))).copy(callers = listOf("notice"))
		val notice = functionRow(
			"notice",
			"Notice",
			listOf("review"),
			steps = listOf(com.atelier_nyaarium.switchboard.proto.FunctionStep.RunFunction("chime", null)),
		)
		fake.functionRows += listOf(notice, chime)
		val owner = automationRow(
			"review",
			1L,
			Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("notice"))),
		)
		fake.shelves["sakura"] = listOf(owner)
		val state = admitting("sakura")
		state.value = state.value.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null))
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(notice, chime)), emptyList())
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val opening = ops.edits.open(key, automationDraftOf(owner, context)!!)!!
		ops.edits.edit(key, opening) { held ->
			held.openedCallee("chime", context.offer).plusStep(Slot(null, null, 1), StepDraft.Return("stop"), tree = "chime")
		}
		fake.functionRows.clear()
		fake.functionRows += listOf(notice, chime.copy(revision = 7L, function = chime.function.copy(steps = listOf(plugStep("off")))))

		ops.reloadFunction(key, opening, "chime")
		val session = ops.edits.state.value.held.getValue(key)
		val callee = session.draft.callees.getValue("chime")

		assertEquals(7L, callee.base)
		assertEquals(listOf(plugStep("off")), callee.steps.map { stepOfDraft(it, context.offer, callee.params, listed(context.offer)) })
		assertEquals(notice.revision, (session.draft.runsDraft() as RunsDraft.Pointing).base)
		assertEquals(AutomationSaid.Note("Reloaded. Your changes to its steps were dropped."), session.said)
	}

	@Test
	fun reloadingAFunctionPointedAtReloadsThePointerNotAStaleCalleeCopy() = runBlocking {
		val fake = FakeGateway().apply { serves = SANDBOX_SERVES }
		val chime = functionRow("chime", "Chime", emptyList(), steps = listOf(plugStep("on"))).copy(callers = listOf("notice"))
		val notice = functionRow(
			"notice",
			"Notice",
			listOf("review"),
			steps = listOf(com.atelier_nyaarium.switchboard.proto.FunctionStep.RunFunction("chime", null)),
		)
		fake.functionRows += listOf(notice, chime)
		val owner = automationRow(
			"review",
			1L,
			Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("notice"))),
		)
		fake.shelves["sakura"] = listOf(owner)
		val state = admitting("sakura")
		state.value = state.value.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null))
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(notice, chime)), emptyList())
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val opening = ops.edits.open(key, automationDraftOf(owner, context)!!)!!
		ops.edits.edit(key, opening) { held -> held.openedCallee("chime", context.offer).pointedTo(chime, context.offer) }
		fake.functionRows.clear()
		fake.functionRows += listOf(notice, chime.copy(revision = 7L, function = chime.function.copy(steps = listOf(plugStep("off")))))

		ops.reloadFunction(key, opening, "chime")
		val session = ops.edits.state.value.held.getValue(key)
		val pointing = session.draft.runsDraft() as RunsDraft.Pointing

		assertEquals(7L to "chime", pointing.base to pointing.functionId)
		assertEquals(false, "chime" in session.draft.callees)
	}

	@Test
	fun aListThatLandsReReadsAnOpenEditsUntouchedCalleeCopy() = runBlocking {
		val fake = FakeGateway().apply { serves = SANDBOX_SERVES }
		val chime = functionRow("chime", "Chime", emptyList(), steps = listOf(plugStep("on"))).copy(callers = listOf("notice"))
		val notice = functionRow(
			"notice",
			"Notice",
			listOf("review"),
			steps = listOf(com.atelier_nyaarium.switchboard.proto.FunctionStep.RunFunction("chime", null)),
		)
		fake.functionRows += listOf(notice, chime)
		val owner = automationRow(
			"review",
			1L,
			Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("notice"))),
		)
		fake.shelves["sakura"] = listOf(owner)
		val state = admitting("sakura")
		state.value = state.value.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null))
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(notice, chime)), emptyList())
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val opening = ops.edits.open(key, automationDraftOf(owner, context)!!)!!
		ops.edits.edit(key, opening) { held -> held.openedCallee("chime", context.offer) }
		fake.functionRows.clear()
		fake.functionRows += listOf(notice, chime.copy(revision = 6L, function = chime.function.copy(steps = listOf(plugStep("off")))))

		ops.refresh("sakura")
		val callee = ops.edits.state.value.held.getValue(key).draft.callees.getValue("chime")

		assertEquals(6L, callee.base)
		assertEquals(listOf(plugStep("off")), callee.steps.map { stepOfDraft(it, context.offer, callee.params, listed(context.offer)) })
	}

	@Test
	fun aReloadAnswerCannotLandAfterItsOpeningWasCleared() = runBlocking {
		val fake = FakeGateway().apply { serves = SANDBOX_SERVES }
		val function = functionRow("notice", "Notice", listOf("review"))
		fake.functionRows += function
		val owner = automationRow(
			"review",
			1L,
			Automation(enabled = true, trigger = AutomationTrigger.Interval(60L), actions = listOf(AutomationAction.RunFunction("notice"))),
		)
		fake.shelves["sakura"] = listOf(owner)
		val state = admitting("sakura")
		state.value = state.value.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, "sakura"), null))
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		val context = EditContext(offerOf(SANDBOX_SERVES, away = false, functions = listOf(function)), emptyList())
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val opening = ops.edits.open(key, automationDraftOf(owner, context)!!)!!
		val hold = TestHold()
		fake.holds["sakura"] = hold

		val reload = launch { ops.reloadFunction(key, opening, "notice") }
		hold.entered.await()
		ops.edits.clear()
		hold.gate.complete(Unit)
		reload.join()

		assertTrue(ops.edits.state.value.held.isEmpty())
	}

	@Test
	fun onlyAGatewayServingFunctionsIsSentTheNewSaveAndTheOtherIsSentTodaysPut() = runBlocking {
		val fake = FakeGateway().apply { shelves["sakura"] = listOf(automationRow()) }
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val serving = EditContext(
			offerOf(SERVES.copy(functions = AutomationFunctionServes(32L, listOf("tell_assistant"), listOf("device", "text", "number"))), away = false, functions = emptyList()),
			emptyList(),
		)
		fun commit(context: EditContext): EditOutcome<AutomationDraft, AutomationSaid>? {
			val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
			ops.edits.show(key)
			val opened = automationDraftOf(fake.shelves.getValue("sakura").single(), context)!!
			val draft = opened.withAction(opened.steps[0].key) { toldDraft("quietly") }
			val shown = ops.edits.open(key, draft)!!
			return runBlocking { ops.commit(key, shown, confirmed = false) }
		}

		assertEquals(EditOutcome.Done, commit(HERE))
		assertEquals(1 to 0, fake.puts.size to fake.saves.size)
		assertEquals(EditOutcome.Done, commit(serving))
		assertEquals(1 to 1, fake.puts.size to fake.saves.size)
		val sent = fake.saves.single()
		assertNull(sent.function)
		assertEquals("review" to 2L, sent.automationId to sent.automationBase)
	}

	@Test
	fun aStaleDraftIsOfferedOverWhatIsHeldAndLandsOnceSaved() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 5L))
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		val opened = automationDraftOf(automationRow(revision = 2L), HERE)!!
		val stale = opened.withAction(opened.steps[0].key) { toldDraft("quietly") }
		ops.edits.show(key)
		val shown = ops.edits.open(key, stale)!!

		assertTrue(ops.commit(key, shown, confirmed = false) is EditOutcome.Stays)
		val offered = ops.edits.state.value.held.getValue(key)
		assertEquals(5L to listOf<Any>(toldDraft("quietly")), offered.draft.revision to offered.draft.steps.filterIsInstance<StepDraft.Action>().map { it.action })
		assertEquals(EditOutcome.Done, ops.commit(key, shown, confirmed = false))
		assertEquals(EditState<AutomationDraftKey, AutomationDraft, AutomationSaid>(), ops.edits.state.value)
	}

	@Test
	fun oneSendReadsOneContextForItsBodyAndItsAnswer() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 5L))
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		ops.refresh("sakura")
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(revision = 2L), HERE)!!)!!
		// Refresh drops event.
		fake.serves = SERVES.copy(triggers = SERVES.triggers.filter { it.kind == "interval" })

		val outcome = ops.commit(key, shown, confirmed = false)

		assertTrue(outcome is EditOutcome.Stays)
		assertEquals(5L, ops.edits.state.value.held.getValue(key).draft.revision)
	}

	@Test
	fun aRefusedDeleteShowsTheHeldRowWithNothingToDiscard() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 5L))
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(revision = 2L), HERE)!!)!!

		val outcome = ops.remove(key, shown)

		assertTrue(outcome is EditOutcome.Stays)
		assertEquals(5L, ops.edits.state.value.held.getValue(key).draft.revision)
		assertTrue(ops.edits.askLeave())
	}

	@Test
	fun backClosesATextOpenOnItsOwnPageBeforeItAsksToLeave() {
		val ops = AutomationOps(admitting("sakura"), Host(FakeGateway()))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(), HERE)!!)!!
		ops.edits.edit(key, shown) { draft -> draft.withAction(draft.steps[0].key) { toldDraft("now", "Hi") }.copy(text = TextRef(draft.steps[0].key, "message")) }

		val first = ops.edits.askLeave()
		val held = ops.edits.state.value.held.getValue(key).draft
		val second = ops.edits.askLeave()

		assertEquals(listOf(false, false), listOf(first, second))
		assertEquals(null to listOf<Any>(toldDraft("now", "Hi")), held.text to held.steps.filterIsInstance<StepDraft.Action>().map { it.action })
		assertEquals(key, ops.edits.state.value.leaving?.key)
	}

	@Test
	fun backClosesThePickerAndMovesTheMirrorsKeyBeforeItAsksToLeave() {
		val ops = AutomationOps(admitting("sakura"), Host(FakeGateway()))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(), HERE)!!)!!
		ops.edits.edit(key, shown) { draft -> draft.withAction(draft.steps[0].key) { toldDraft("now", "Hi") }.copy(picking = true) }
		val openKey = ops.edits.page(ops.edits.state.value.held.getValue(key).draft)

		val first = ops.edits.askLeave()
		val held = ops.edits.state.value.held.getValue(key).draft
		val second = ops.edits.askLeave()

		assertEquals(listOf(false, false), listOf(first, second))
		assertFalse(held.picking)
		assertEquals(listOf<Any>(toldDraft("now", "Hi")), held.steps.filterIsInstance<StepDraft.Action>().map { it.action })
		assertTrue(openKey != null && ops.edits.page(held) == null)
		assertEquals(key, ops.edits.state.value.leaving?.key)
	}

	@Test
	fun aChangedAutomationDraftAsksBeforeLeaving() {
		val ops = AutomationOps(admitting("sakura"), Host(FakeGateway()))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(), HERE)!!)!!

		ops.edits.edit(key, shown) { draft -> draft.withAction(draft.steps[0].key) { toldDraft("quietly") } }

		assertFalse(ops.edits.askLeave())
	}
}
