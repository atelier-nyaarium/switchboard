package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
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

class AutomationOpsTest {
	private class FakeGateway : AutomationGateway {
		val shelves = mutableMapOf<String, List<AutomationRow>>()
		val refusing = mutableSetOf<String>()
		val unreachable = mutableSetOf<String>()
		val holds = mutableMapOf<String, TestHold>()
		val putHolds = mutableMapOf<String, TestHold>()
		val puts = mutableListOf<Triple<String, String, Long>>()
		var deletes = 0

		override suspend fun list(gatewayId: String): ListAnswer<AutomationRow> {
			val listed = shelves[gatewayId].orEmpty()
			holds.remove(gatewayId)?.pass()
			if (gatewayId in refusing) return ListAnswer.NotServed
			if (gatewayId in unreachable) throw IllegalStateException("unreachable")
			return ListAnswer.Listed(listed)
		}

		override suspend fun put(
			gatewayId: String,
			automationId: String,
			automation: Automation,
			baseRevision: Long,
		): ConsoleAutomationPutResult {
			putHolds.remove(gatewayId)?.pass()
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

		override suspend fun preview(gatewayId: String, trigger: AutomationTrigger): ConsoleAutomationPreviewResult? =
			ConsoleAutomationPreviewResult(matched = 1L, of = 3L, matches = emptyList())
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
	fun everyWriteRunsUnderTheMoveLock() = runBlocking {
		val fake = FakeGateway().apply { shelves["sakura"] = listOf(automationRow()) }
		val host = LockingHost(fake)
		val ops = AutomationOps(admitting("sakura"), host)

		ops.save("sakura", "new", automation(), 0L)
		ops.setEnabled("sakura", automationRow(), false)
		ops.delete("sakura", "new", 1L)
		host.home = "mikan"
		val moved = listOf(
			ops.save("sakura", "late", automation(), 0L),
			ops.setEnabled("sakura", automationRow(), true),
			ops.delete("sakura", "review", 2L),
		)

		assertEquals(3, host.writes)
		assertEquals(List(3) { AutomationSaved.Refused(HOME_MOVED) }, moved)
	}

	private fun admitting(vararg ids: String) = MutableStateFlow(ChatState(gateways = testRegistry(*ids)))

	private fun ChatState.drawn() = gateways.gateways.filter { it.automations.listed }.map { it.id }

	@Test
	fun listedGatewaysAreDrawnWhileRefusalHidesAndUnreachableKeepsTheLastList() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow())
		fake.refusing += "old-box"
		val state = admitting("sakura", "old-box")
		val ops = AutomationOps(state, Host(fake))

		runBlocking { ops.refreshAll() }
		assertEquals(listOf("sakura"), state.value.drawn())
		assertEquals("review", state.value.gateways.entry("sakura")?.automations?.rows?.single()?.id)

		fake.unreachable += "sakura"
		runBlocking { ops.refreshAll() }
		assertEquals("review", state.value.gateways.entry("sakura")?.automations?.rows?.single()?.id)

		fake.unreachable -= "sakura"
		fake.refusing += "sakura"
		runBlocking { ops.refreshAll() }
		assertTrue(state.value.drawn().isEmpty())
	}

	@Test
	fun aRefusalFromAGatewayThatServesSourcesIsAFaultSoItsListStaysDrawn() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow())
		val state = admitting("sakura")
		val serving = AssistantWord.Answered(
			com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult(workdir = "~/notes", sources = emptyList()),
		)
		state.value = state.value.copy(gateways = state.value.gateways.withEntry("sakura") { it.copy(assistant = serving) })
		val ops = AutomationOps(state, Host(fake))
		runBlocking { ops.refreshAll() }

		fake.refusing += "sakura"
		runBlocking { ops.refreshAll() }

		assertEquals(listOf("sakura"), state.value.drawn())
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
		assertEquals("New", state.value.gateways.entry("sakura")?.automations?.rows?.single()?.sentence)
		hold.gate.complete(Unit)
		older.join()

		assertEquals("New", state.value.gateways.entry("sakura")?.automations?.rows?.single()?.sentence)
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
		assertEquals("the held revision differs", ops.toggleRefusalFor("sakura", "review"))
		assertEquals(true, state.value.gateways.entry("sakura")?.automations?.rows?.single()?.automation?.enabled)

		val current = state.value.gateways.entry("sakura")!!.automations.rows.single()
		assertTrue(runBlocking { ops.setEnabled("sakura", current, false) } is AutomationSaved.Stored)
		assertNull(ops.toggleRefusalFor("sakura", "review"))
		assertEquals(false, state.value.gateways.entry("sakura")?.automations?.rows?.single()?.automation?.enabled)
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
		val row = state.value.gateways.entry("sakura")!!.automations.rows.single()
		assertTrue(ops.setEnabled("sakura", row, false) is AutomationSaved.Stored)
		hold.gate.complete(Unit)
		older.join()

		assertNull(ops.toggleRefusalFor("sakura", "review"))
		assertEquals(false, state.value.gateways.entry("sakura")?.automations?.rows?.single()?.automation?.enabled)
	}

	@Test
	fun saveRefusalCarriesTheNewerHeldRowAndEveryMutationRefreshes() {
		val fake = FakeGateway()
		val newer = automationRow(revision = 5L)
		fake.shelves["sakura"] = listOf(newer)
		val state = admitting("sakura")
		val ops = AutomationOps(state, Host(fake))

		val refused = runBlocking { ops.save("sakura", "review", automation(), 3L) }		as? AutomationSaved.Refused
		assertEquals(newer, refused?.heldRow)
		assertEquals("the held revision differs", refused?.reason)
		assertEquals(newer, state.value.gateways.entry("sakura")?.automations?.rows?.single())

		assertTrue(runBlocking { ops.save("sakura", "new", automation(), 0L) } is AutomationSaved.Stored)
		assertEquals(listOf(3L, 0L), fake.puts.map { it.third })
	}

	@Test
	fun deleteUsesTheGatewaysAnswerAndPreviewReturnsItsListing() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow())
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		runBlocking { ops.refresh("sakura") }

		assertEquals(AutomationSaved.Stored(null), runBlocking { ops.delete("sakura", "review", 1L) })
		assertEquals(1L, runBlocking { ops.preview("sakura", automation().trigger) }?.matched)
	}

	@Test
	fun aStaleDraftIsOfferedOverWhatIsHeldAndLandsOnceSaved() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 5L))
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		val stale = automationDraftOf(automationRow(revision = 2L)).copy(tell = "quietly")
		val save: suspend (AutomationDraft) -> AutomationSaved = { ops.save("sakura", it.id, it.toAutomation()!!, it.revision) }
		val shown = ops.edits.open(key, stale)

		assertTrue(ops.send(key, shown, deleting = false, save) is EditOutcome.Stays)
		val offered = ops.edits.held.value.getValue(key)
		assertEquals(5L to "quietly", offered.draft.revision to offered.draft.tell)
		assertEquals(EditOutcome.Done, ops.send(key, shown, deleting = false, save))
		assertNull(ops.edits.held.value[key])
		assertEquals(EditorShowing.CLOSING, editorShowing(shown, ops.edits.held.value[key]))
	}

	@Test
	fun aRefusedDeleteShowsTheHeldRowWithNothingToDiscard() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(automationRow(revision = 5L))
		val ops = AutomationOps(admitting("sakura"), Host(fake))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		val shown = ops.edits.open(key, automationDraftOf(automationRow(revision = 2L)))

		val outcome = ops.send(key, shown, deleting = true) { ops.delete("sakura", it.id, it.revision) }

		assertTrue(outcome is EditOutcome.Stays)
		assertEquals(5L, ops.edits.held.value.getValue(key).draft.revision)
		assertTrue(ops.edits.askLeave(key))
	}

	@Test
	fun aChangedAutomationDraftAsksBeforeLeaving() {
		val ops = AutomationOps(admitting("sakura"), Host(FakeGateway()))
		val key = AutomationDraftKey("sakura", AutomationSlot.Held("review"))
		val shown = ops.edits.open(key, automationDraftOf(automationRow()))

		ops.edits.edit(key, shown) { it.copy(tell = "quietly") }

		assertFalse(ops.edits.askLeave(key))
	}
}
