package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import kotlinx.coroutines.flow.MutableStateFlow
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

		private fun shelf(gatewayId: String) = stored.getOrPut(gatewayId) { mutableMapOf() }

		private fun sameContent(a: Runbook, b: Runbook) = a.name == b.name && a.body == b.body &&
			a.parameters == b.parameters

		val listed = mutableListOf<String>()

		override suspend fun list(gatewayId: String): ConsoleRunbookListResult {
			listed += gatewayId
			return ConsoleRunbookListResult(runbooks = shelf(gatewayId).values.sortedWith(compareBy({ it.name }, { it.id })))
		}

		override suspend fun put(
			gatewayId: String,
			runbook: Runbook,
			baseRevision: Long?,
			overwrite: Boolean,
		): ConsoleRunbookPutResult {
			puts += Triple(runbook, baseRevision, overwrite)
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

	private fun ChatState.books(gatewayId: String = GW) = gateways.runbooksOn(gatewayId)

	private fun opsOver(library: List<Runbook>): Pair<RunbookOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val host = NoGateway()
		host.library.merge(GW, library)
		return RunbookOps(state, host) to state
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
		val ops = RunbookOps(state, host)

		val first = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW) }
		assertEquals(RunbookSaved.Stored, first)
		// Sent no base, since nothing was stored yet, and took back what the gateway named.
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
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host)
		kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW) }

		// The editor never heard, so it names the base it read rather than the one now stored.
		val again = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW, baseRevision = null) }
		assertEquals(RunbookSaved.Stored, again)
		// Still the first revision, so the retry did not land as a second edit.
		val held = kotlinx.coroutines.runBlocking { host.fake.list(GW) }
		assertEquals(1L, held.runbooks.single().revision)
	}

	@Test
	fun aSaveTheGatewayRefusesLeavesTheLibraryAlone() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER)))
		val ops = RunbookOps(state, host)
		kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), GW) }

		val refused = kotlinx.coroutines.runBlocking {
			ops.save(book("a", name = "Stale", revision = 1L), GW, baseRevision = 7L)
		}
		assertEquals(true, refused is RunbookSaved.Refused)
		assertEquals("a", state.value.books().first { it.id == "a" }.name)
	}

	@Test
	fun anEditInProgressOutlivesTheScreenAndBelongsToOneGateway() {
		val (ops, _) = opsOver(listOf(book("a")))
		val here = com.atelier_nyaarium.switchboard.runbooks.RunbookDraft(id = "a", name = "Here")
		val there = com.atelier_nyaarium.switchboard.runbooks.RunbookDraft(id = "a", name = "There")

		ops.keepDraft(GW, "a", here)
		ops.keepDraft(OTHER, "a", there)
		// What a recreated editor asks for, holding nothing of its own.
		assertEquals(here, ops.draftFor(GW, "a"))
		assertEquals(there, ops.draftFor(OTHER, "a"))

		// Closing one editor leaves the other still being typed.
		ops.dropDraft(GW, "a")
		assertEquals(null, ops.draftFor(GW, "a"))
		assertEquals(there, ops.draftFor(OTHER, "a"))
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
		val ops = RunbookOps(state, host)

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
	fun refreshingOneGatewayDoesNotReopenTheSyncOnAnother() {
		val host = WithGateway()
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host)

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
		val ops = RunbookOps(state, host)
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
		val ops = RunbookOps(MutableStateFlow(ChatState(gateways = testRegistry(GW, OTHER))), host)

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
