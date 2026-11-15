package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.async
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

private const val GW = "gw"
private const val OTHER = "other"

class RunbookOpsTest {
	private class MemoryStore : com.atelier_nyaarium.switchboard.runbooks.RunbookStore {
		private var blob: String? = null
		override fun loadRunbooks() = blob
		override fun saveRunbooks(json: String) { blob = json }
	}

	private class NoGateway(store: MemoryStore = MemoryStore()) : RunbookHost {
		override val gateway: RunbookGateway? = null
		override val library = com.atelier_nyaarium.switchboard.runbooks.RunbookManager(store)
	}

	/**
	 * The rules of `src/gateway/runbooks/store.ts`, per gateway. A fake that answers differently
	 * teaches its tests the wrong contract, so this mirrors that store rather than approximating it.
	 */
	private class FakeGateway : RunbookGateway {
		val stored = mutableMapOf<String, MutableMap<String, Runbook>>()
		val puts = mutableListOf<Triple<Runbook, Long?, Boolean>>()
		var putHold: TestHold? = null

		private fun shelf(gatewayId: String) = stored.getOrPut(gatewayId) { mutableMapOf() }

		private fun sameContent(a: Runbook, b: Runbook) = a.name == b.name && a.body == b.body &&
			a.parameters == b.parameters

		val listed = mutableListOf<String>()

		override suspend fun list(gatewayId: String): ListAnswer<Runbook> {
			listed += gatewayId
			return ListAnswer.Listed(shelf(gatewayId).values.sortedWith(compareBy({ it.name }, { it.id })))
		}

		override suspend fun put(
			gatewayId: String,
			runbook: Runbook,
			baseRevision: Long?,
			overwrite: Boolean,
		): ConsoleRunbookPutResult {
			puts += Triple(runbook, baseRevision, overwrite)
			putHold?.pass()
			val shelf = shelf(gatewayId)
			val held = shelf[runbook.id]
			if (held == null && baseRevision != null) {
				return ConsoleRunbookPutResult(stored = false, revision = 0L, reason = "nothing stored")
			}
			if (held != null && !overwrite) {
				val lost = (baseRevision == null && held.revision == 1L) ||
					baseRevision == held.revision ||
					baseRevision == held.revision - 1
				if (lost && sameContent(runbook, held)) {
					return ConsoleRunbookPutResult(stored = true, revision = held.revision, runbook = held)
				}
				if (baseRevision != held.revision) {
					return ConsoleRunbookPutResult(stored = false, revision = held.revision, reason = "moved on")
				}
			}
			val minted = runbook.copy(revision = (held?.revision ?: 0L) + 1)
			shelf[runbook.id] = minted
			return ConsoleRunbookPutResult(stored = true, revision = minted.revision, runbook = minted)
		}

		override suspend fun delete(gatewayId: String, runbookId: String) =
			ConsoleRunbookDeleteResult(deleted = shelf(gatewayId).remove(runbookId) != null)

		override suspend fun preview(gatewayId: String, runbookId: String, values: Map<String, String>) =
			ConsoleRunbookPreviewResult(text = "rendered", revision = shelf(gatewayId)[runbookId]?.revision ?: 0L)

		override suspend fun fire(
			gatewayId: String,
			runbookId: String,
			values: Map<String, String>,
			into: RunbookFireTarget,
			previewedRevision: Long?,
		) = ConsoleRunbookFireResult(fired = true)
	}

	private class WithGateway(val fake: FakeGateway = FakeGateway()) : RunbookHost {
		override val gateway: RunbookGateway = fake
		override val library = com.atelier_nyaarium.switchboard.runbooks.RunbookManager(MemoryStore())
	}

	private fun book(id: String, name: String = id, revision: Long = 1L) = Runbook(
		id = id,
		name = name,
		body = "cut a {{level}} release",
		parameters = listOf(RunbookParameter(name = "level", label = "Level", kind = "text")),
		revision = revision,
	)

	private fun ChatState.books(gatewayId: String = GW) = gateways.entry(gatewayId)?.runbooks?.listedRows().orEmpty()

	private fun opsOver(library: List<Runbook>): Pair<RunbookOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val host = NoGateway()
		host.library.merge(GW, library)
		return RunbookOps(state, host, ProvisionFence()) to state
	}

	@Test
	fun aFireIntoASessionStillStartingIsNeitherDeliveredNorRefused() {
		assertEquals(FireOutcome.Delivered, fireOutcome(ConsoleRunbookFireResult(fired = true, sessionId = "s1")))
		assertEquals(FireOutcome.Starting, fireOutcome(ConsoleRunbookFireResult(fired = true, sessionId = "s1", status = "starting")))
		assertEquals(FireOutcome.NotFired("busy"), fireOutcome(ConsoleRunbookFireResult(fired = false, reason = "busy")))
		assertEquals(FireOutcome.NotFired(null), fireOutcome(null))
	}

	@Test
	fun savingWithNoGatewayKeepsTheCopyAndSaysItIsLocal() {
		val (ops, state) = opsOver(listOf(book("b", name = "Zebra"), book("a", name = "Apple")))

		assertEquals(RunbookSaved.Local, kotlinx.coroutines.runBlocking { ops.save(book("c", name = "Apple"), GW) })
		assertEquals(listOf("a", "c", "b"), state.value.books().map { it.id })

		kotlinx.coroutines.runBlocking { ops.save(book("a", name = "Apple", revision = 4L), GW) }
		assertEquals(4L, state.value.books().first { it.id == "a" }.revision)
	}

	@Test
	fun aGatewayIsGivenTheLibrarysCopyUnlessItAlreadyHoldsThatExactOne() {
		val mine = book("a", revision = 3L)
		assertEquals(PushDecision.Put, pushDecision(mine, null))
		assertEquals(PushDecision.Put, pushDecision(mine, book("a", revision = 2L)))
		assertEquals(PushDecision.Ready, pushDecision(mine, mine))

		assertEquals(PushDecision.Put, pushDecision(mine, book("a", name = "Renamed", revision = 3L)))

		val theirs = book("a", revision = 9L)
		assertEquals(PushDecision.Adopt(theirs), pushDecision(mine, theirs))
	}

	@Test
	fun aSaveSendsTheBaseItReadAndKeepsTheRevisionTheGatewayNamed() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val ops = RunbookOps(state, host, ProvisionFence())

		val first = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW) }
		assertEquals(RunbookSaved.Stored, first)
		// No base sent; took the gateway's.
		assertEquals(null, host.fake.puts[0].second)
		assertEquals(1L, state.value.books().first { it.id == "a" }.revision)

		val second = kotlinx.coroutines.runBlocking {
			ops.save(book("a", name = "Two", revision = 1L), GW, baseRevision = 1L)
		}
		assertEquals(RunbookSaved.Stored, second)
		assertEquals(1L, host.fake.puts[1].second)
		assertEquals(2L, state.value.books().first { it.id == "a" }.revision)
	}

	@Test
	fun aRetryOfAnAnswerThatWasLostIsNotASecondEdit() {
		val host = WithGateway()
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host, ProvisionFence())
		kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW) }

		// Names the base it read.
		val again = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW, baseRevision = null) }
		assertEquals(RunbookSaved.Stored, again)
		// Still the first revision, so the retry did not land as a second edit.
		val held = kotlinx.coroutines.runBlocking { host.fake.list(GW) }
		assertEquals(1L, (held as ListAnswer.Listed).rows.single().revision)
	}

	@Test
	fun aSaveTheGatewayRefusesLeavesTheLibraryAlone() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val ops = RunbookOps(state, host, ProvisionFence())
		kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW) }

		val refused = kotlinx.coroutines.runBlocking {
			ops.save(book("a", name = "Stale", revision = 1L), GW, baseRevision = 7L)
		}
		assertEquals(true, refused is RunbookSaved.Refused)
		assertEquals("a", state.value.books().first { it.id == "a" }.name)
	}

	@Test
	fun aSaveStillOutAtAReprovisionWritesNothingToTheNextOwnersLibrary() = kotlinx.coroutines.runBlocking<Unit> {
		val host = WithGateway()
		val provision = ProvisionFence()
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW))), host, provision)
		val hold = TestHold().also { host.fake.putHold = it }

		val saved = async { ops.save(book("a", revision = 0L), GW) }
		hold.entered.await()
		// Library first; roster order irrelevant.
		provision.reprovision {
			host.library.clearInMemory()
			ops.clearInMemory()
		}
		hold.release()

		assertEquals(true, saved.await() is RunbookSaved.Refused)
		assertEquals(null, host.library.find(GW, "a"))
		assertEquals(null, ops.refusalFor(GW, "a"))
	}

	@Test
	fun anEditorsSaveLandsOnItsOpeningAndADeleteItsGatewayNeverTookStays() {
		val host = WithGateway()
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host, ProvisionFence())
		val key = EditKey(GW, null)
		val draft = com.atelier_nyaarium.switchboard.runbooks.RunbookDraft.of(book("a")).copy(revision = 0L)
		ops.edits.show(key)
		val opening = ops.edits.open(key, draft)!!

		assertEquals(EditOutcome.Done, kotlinx.coroutines.runBlocking { ops.commit(key, opening, overwrite = false) })
		assertEquals(null, ops.edits.state.value.shown)
		assertEquals(null, ops.edits.state.value.held[key])

		kotlinx.coroutines.runBlocking { host.fake.delete(GW, "a") }
		ops.edits.show(key)
		val reopened = ops.edits.open(key, draft)!!
		kotlinx.coroutines.runBlocking { ops.remove(key, reopened) }
		assertEquals("This Gateway still holds it; it was not reached", ops.edits.state.value.held.getValue(key).said?.reason)
	}

	@Test
	fun deletingTakesItOutOfTheLibraryEvenWithNoGatewayToTell() {
		val (ops, state) = opsOver(listOf(book("a"), book("b")))
		kotlinx.coroutines.runBlocking { ops.delete("a", GW) }
		assertEquals(listOf("b"), state.value.books().map { it.id })
	}

	@Test
	fun oneGatewaysGroupIsReplacedWithoutDisturbingAnother() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val ops = RunbookOps(state, host, ProvisionFence())

		kotlinx.coroutines.runBlocking {
			ops.save(book("a", name = "Here"), GW)
			ops.save(book("a", name = "There"), OTHER)
			// A delete on one Gateway is not a delete on the other, whatever the id.
			ops.delete("a", GW)
		}
		assertEquals(emptyList<String>(), state.value.books(GW).map { it.id })
		assertEquals(listOf("There"), state.value.books(OTHER).map { it.name })
	}

	@Test
	fun aLibraryNeverPlacedSaysItsReadFailedAndADeleteSaysWhenRoutinesAreUnread() {
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW)))
		val ops = RunbookOps(state, NoGateway(), ProvisionFence())
		assertEquals(GatewayList.Unread, state.value.gateways.entry(GW)?.runbooks)

		kotlinx.coroutines.runBlocking { ops.refresh(GW) }

		assertEquals(GatewayList.Unreachable, state.value.gateways.entry(GW)?.runbooks)
		val pinned = com.atelier_nyaarium.switchboard.proto.RoutineState(testRoutine("triage", runbookId = "a"))
		val listed = runbookDeleteLine(GatewayList.Listed(listOf(pinned)), "a")
		val unpinned = runbookDeleteLine(GatewayList.Listed(listOf(pinned)), "b")
		assertEquals(true, listed.contains("triage"))
		assertEquals(unpinned, runbookDeleteLine(GatewayList.NotServed, "a"))
		assertNotEquals(unpinned, runbookDeleteLine(GatewayList.Unread, "a"))
		assertEquals(runbookDeleteLine(GatewayList.Unread, "a"), runbookDeleteLine(GatewayList.Unreachable, "a"))
	}

	@Test
	fun aDrawnLibraryOutlivesNotServedAndOnlyAnEmptyOneSaysIt() {
		val drawn = GatewayList.Listed(listOf(book("a")))
		val empty = GatewayList.Listed(emptyList<Runbook>())

		assertEquals(drawn, runbooksAfter(drawn, ListAnswer.NotServed))
		assertEquals(GatewayList.NotServed, runbooksAfter(empty, ListAnswer.NotServed))
		assertEquals(GatewayList.NotServed, runbooksAfter(GatewayList.Unread, ListAnswer.NotServed))
		assertEquals(drawn, runbooksAfter(drawn, ListAnswer.Unreachable))
	}

	@Test
	fun refreshingOneGatewayDoesNotReopenTheSyncOnAnother() {
		val host = WithGateway()
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host, ProvisionFence())

		kotlinx.coroutines.runBlocking {
			ops.save(book("a"), OTHER)
			ops.refresh(GW)
			host.fake.listed.clear()
			// OTHER is still known to be in step, so a fire there asks it nothing. Clearing every
			// gateway's markers while refreshing one would re-read that library for nothing.
			ops.preview("a", emptyMap(), OTHER)
			assertEquals(emptyList<String>(), host.fake.listed)
		}
	}

	@Test
	fun aGatewayThatKeepsItKeepsThePhonesCopyToo() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val ops = RunbookOps(state, host, ProvisionFence())
		host.library.merge(GW, listOf(book("a")))

		// The Gateway holds no such id, so it answers no, and the owner is not shown a library that
		// lost what the Gateway may still have.
		kotlinx.coroutines.runBlocking {
			assertEquals(false, ops.delete("a", GW))
			assertEquals(listOf("a"), host.library.all(GW).map { it.id })
		}
	}

	@Test
	fun aRefusedPushStandsUntilAPutIsTaken() {
		val refused = ConsoleRunbookPutResult(stored = false, revision = 7L, reason = "held newer")
		val key = GW to "a"
		val raised = refusalsAfterPut(emptyMap(), key, refused)
		assertEquals(SaveRefusal("held newer", 7L), raised[key])

		assertEquals(raised, refusalsAfterPut(raised, key, null))
		assertEquals(emptyMap<Pair<String, String>, SaveRefusal>(), refusalsAfterPut(raised, key, refused.copy(stored = true)))

		// One Gateway's refusal says nothing about another's copy of that id.
		assertEquals(null, raised[OTHER to "a"])
	}

	@Test
	fun aRefusalOnOneGatewayLeavesTheEditorOnAnotherUnblocked() {
		val host = WithGateway()
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host, ProvisionFence())

		kotlinx.coroutines.runBlocking {
			ops.save(book("a", revision = 1L), GW)
			ops.save(book("a", name = "Stale", revision = 1L), GW, baseRevision = 7L)
		}
		assertNotEquals(null, ops.refusalFor(GW, "a"))
		assertEquals(null, ops.refusalFor(OTHER, "a"))
	}

	@Test
	fun aSaveTheLibraryDidNotTakeIsRefusedRatherThanSilentlyLost() {
		val (ops, _) = opsOver(listOf(book("a", revision = 4L)))

		val saved = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 4L).copy(body = "stale"), GW) }
		assertEquals(4L, (saved as? RunbookSaved.Refused)?.refusal?.heldRevision)
	}

	@Test
	fun aGatewaysRefusalIsReadFromItsOwnAnswer() {
		val refused = ConsoleRunbookPutResult(stored = false, revision = 7L, reason = "held newer")
		assertEquals(SaveRefusal("held newer", 7L), gatewayRefusal(refused))
		assertEquals(7L, gatewayRefusal(refused.copy(reason = null)).heldRevision)
	}

	@Test
	fun aRefusalBelowTheDraftIsSpentSoTheEditorStopsOfferingIt() {
		val refusal = SaveRefusal("held newer", 7L)
		assertEquals(refusal, standingRefusal(refusal, 7L))
		assertEquals(null, standingRefusal(refusal, 8L))
	}

	@Test
	fun theRefusalThisSaveEarnedOutranksTheOneLeftStanding() {
		val standing = SaveRefusal("held newer", 7L)
		val earned = SaveRefusal("this Gateway holds a different copy", 9L)
		assertEquals(earned, refusalToShow(earned, standing, 7L))
		assertEquals(standing, refusalToShow(null, standing, 7L))
		// Spent, so nothing is offered rather than the older story.
		assertEquals(null, refusalToShow(null, standing, 8L))
	}

	@Test
	fun firingWithoutAGatewayAnswersNothingRatherThanThrowing() {
		val (ops, _) = opsOver(listOf(book("a")))
		val answer = kotlinx.coroutines.runBlocking {
			ops.fire(
				"a",
				emptyMap(),
				com.atelier_nyaarium.switchboard.proto.RunbookFireTarget.Session("host.x"),
				1L,
				GW,
			)
		}
		assertEquals(null, answer)
	}
}
