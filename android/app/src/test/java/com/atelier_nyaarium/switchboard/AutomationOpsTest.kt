package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.IntervalUnit
import com.atelier_nyaarium.switchboard.assistant.TextRef
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.offerOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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
	switches = emptyList(),
)


private val HERE = EditContext(offerOf(null, away = false), emptyList())

class AutomationOpsTest {
	private class FakeGateway : AutomationGateway {
		val shelves = mutableMapOf<String, List<AutomationRow>>()
		val refusing = mutableSetOf<String>()
		val prosing = mutableSetOf<String>()
		var serves = SERVES
		val unreachable = mutableSetOf<String>()
		val holds = mutableMapOf<String, TestHold>()
		val putHolds = mutableMapOf<String, TestHold>()
		val puts = mutableListOf<Triple<String, String, Long>>()
		val confirmed = mutableListOf<Boolean>()
		/** Answered in place of a write. */
		val answers = ArrayDeque<ConsoleAutomationPutResult>()
		var deletes = 0

		override suspend fun list(gatewayId: String): AutomationListing {
			val listed = shelves[gatewayId].orEmpty()
			holds.remove(gatewayId)?.pass()
			if (gatewayId in refusing) return AutomationListing(ListAnswer.NotServed)
			if (gatewayId in prosing) return AutomationListing(ListAnswer.NotServed, prose = true)
			if (gatewayId in unreachable) throw IllegalStateException("unreachable")
			return AutomationListing(ListAnswer.Listed(listed), serves)
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

		override suspend fun preview(gatewayId: String, trigger: AutomationTrigger, text: String?): ConsoleAutomationPreviewResult? =
			ConsoleAutomationPreviewResult(matched = 1L, of = 3L, matches = emptyList(), filled = text)

		val saves = mutableListOf<ConsoleOp.AutomationSave>()

		override suspend fun save(gatewayId: String, op: ConsoleOp.AutomationSave): ConsoleAutomationSaveResult {
			saves += op
			val stored = automationRow(id = op.automationId, revision = op.automationBase + 1L, automation = op.automation)
			shelves[gatewayId] = shelves[gatewayId].orEmpty().filterNot { it.id == op.automationId } + stored
			return ConsoleAutomationSaveResult(stored = true, automation = stored)
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
		ops.edits.edit(key, shown) { it.copy(text = TextRef(0, "message")) }
		val kept = said()
		ops.edits.edit(key, shown) { it.withAction(0) { toldDraft("quietly") } }
		val dropped = said()
		ops.commit(key, shown, confirmed = false)
		ops.edits.edit(key, shown) { it.withAction(0) { toldDraft("now") } }

		assertEquals(AutomationSaid.Confirm(listOf("Send to IFTTT")), kept)
		assertNull(dropped)
		assertEquals(AutomationSaid.Line("no"), said())
	}

	@Test
	fun aListingSaysWhatItsGatewayHoldsAndARefusedSaveCarriesWhatToAskAndWhereAHoleFailed() = runBlocking {
		val fake = FakeGateway().apply { shelves["sakura"] = emptyList() }
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))
		ops.refresh("sakura")
		fake.answers += ConsoleAutomationPutResult(false, 0L, reason = "confirm", confirm = listOf("Send to IFTTT"))
		fake.answers += ConsoleAutomationPutResult(false, 0L, reason = "no name x here", hole = AutomationHoleSpan(0L, "message", 3L, 6L))

		val asks = ops.save("sakura", "new", automation(), 0L, stored = null) as AutomationSaved.Refused
		val hole = ops.save("sakura", "new", automation(), 0L, stored = null) as AutomationSaved.Refused
		ops.save("sakura", "new", automation(), 0L, stored = null, confirmed = true)

		assertEquals(SERVES, state.value.gateways.entry("sakura")?.automationServes)
		assertEquals(listOf("Send to IFTTT"), asks.confirm)
		assertEquals(AutomationHoleSpan(0L, "message", 3L, 6L), hole.hole)
		assertEquals(listOf(false, false, true), fake.confirmed)
	}

	private val serving = AssistantRead.Answered(
		com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult(workdir = "~/notes", sources = emptyList()),
	)
	private val older = AssistantRead.Answered(com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult(workdir = "~/notes"))

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
	fun theTokenAlwaysReadsNotServedAndProseOnlyFromAStateAnsweredWithoutSources() {
		val reads = mapOf("unread" to AssistantRead.Reading, "refused" to AssistantRead.Refused, "serving" to serving, "older" to older)
		val landed = { prose: Boolean ->
			val fake = FakeGateway()
			reads.keys.forEach { fake.shelves[it] = listOf(automationRow()) }
			val state = admitting(*reads.keys.toTypedArray())
			state.value = state.value.copy(
				gateways = reads.entries.fold(state.value.gateways) { held, (id, read) -> held.withEntry(id) { it.copy(assistant = read) } },
			)
			val ops = AutomationOps(state, Host(fake))
			runBlocking { ops.refreshAll() }
			(if (prose) fake.prosing else fake.refusing) += reads.keys
			runBlocking { ops.refreshAll() }
			reads.keys.associateWith { state.value.gateways.entry(it)?.automations }
		}
		val drawn = GatewayList.Listed(listOf(automationRow()))

		assertEquals(reads.mapValues { GatewayList.NotServed }, landed(false))
		assertEquals(mapOf("unread" to drawn, "refused" to drawn, "serving" to drawn, "older" to GatewayList.NotServed), landed(true))
		assertEquals(listOf(false, false, false, true), reads.values.map(::saysOlderBuild))
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
		assertEquals(1L, runBlocking { ops.preview("sakura", automation().trigger) }?.matched)
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
			val draft = automationDraftOf(fake.shelves.getValue("sakura").single(), context)!!.withAction(0) { toldDraft("quietly") }
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
		val stale = automationDraftOf(automationRow(revision = 2L), HERE)!!.withAction(0) { toldDraft("quietly") }
		ops.edits.show(key)
		val shown = ops.edits.open(key, stale)!!

		assertTrue(ops.commit(key, shown, confirmed = false) is EditOutcome.Stays)
		val offered = ops.edits.state.value.held.getValue(key)
		assertEquals(5L to listOf<Any>(toldDraft("quietly")), offered.draft.revision to offered.draft.actions)
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
		ops.edits.edit(key, shown) { it.withAction(0) { toldDraft("now", "Hi") }.copy(text = TextRef(0, "message")) }

		val first = ops.edits.askLeave()
		val held = ops.edits.state.value.held.getValue(key).draft
		val second = ops.edits.askLeave()

		assertEquals(listOf(false, false), listOf(first, second))
		assertEquals(null to listOf<Any>(toldDraft("now", "Hi")), held.text to held.actions)
		assertEquals(key, ops.edits.state.value.leaving?.key)
	}

	@Test
	fun backClosesThePickerAndMovesTheMirrorsKeyBeforeItAsksToLeave() {
		val ops = AutomationOps(admitting("sakura"), Host(FakeGateway()))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(), HERE)!!)!!
		ops.edits.edit(key, shown) { it.withAction(0) { toldDraft("now", "Hi") }.copy(picking = true) }
		val openKey = ops.edits.page(ops.edits.state.value.held.getValue(key).draft)

		val first = ops.edits.askLeave()
		val held = ops.edits.state.value.held.getValue(key).draft
		val second = ops.edits.askLeave()

		assertEquals(listOf(false, false), listOf(first, second))
		assertFalse(held.picking)
		assertEquals(listOf<Any>(toldDraft("now", "Hi")), held.actions)
		assertTrue(openKey != null && ops.edits.page(held) == null)
		assertEquals(key, ops.edits.state.value.leaving?.key)
	}

	@Test
	fun aChangedAutomationDraftAsksBeforeLeaving() {
		val ops = AutomationOps(admitting("sakura"), Host(FakeGateway()))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		ops.edits.show(key)
		val shown = ops.edits.open(key, automationDraftOf(automationRow(), HERE)!!)!!

		ops.edits.edit(key, shown) { it.withAction(0) { toldDraft("quietly") } }

		assertFalse(ops.edits.askLeave())
	}
}
