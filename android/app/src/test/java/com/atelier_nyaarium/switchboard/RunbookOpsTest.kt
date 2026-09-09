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
import org.junit.Test

class RunbookOpsTest {
	private class MemoryStore : com.atelier_nyaarium.switchboard.runbooks.RunbookStore {
		private var blob: String? = null
		override fun loadRunbooks() = blob
		override fun saveRunbooks(json: String) { blob = json }
	}

	private class NoGateway(store: MemoryStore = MemoryStore()) : RunbookHost {
		override val gateway: RunbookGateway? = null
		override fun homeGatewayId() = ""
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

		override suspend fun list(gatewayId: String) = ConsoleRunbookListResult(
			runbooks = shelf(gatewayId).values.sortedWith(compareBy({ it.name }, { it.id })),
		)

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
		override fun homeGatewayId() = "gw"
		override val library = com.atelier_nyaarium.switchboard.runbooks.RunbookManager(MemoryStore())
	}

	private fun book(id: String, name: String = id, revision: Long = 1L) = Runbook(
		id = id,
		name = name,
		body = "cut a {{level}} release",
		parameters = listOf(RunbookParameter(name = "level", label = "Level", kind = "text")),
		revision = revision,
	)

	private fun opsOver(library: List<Runbook>): Pair<RunbookOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState())
		val host = NoGateway()
		host.library.merge(host.homeGatewayId(), library)
		return RunbookOps(state, host) to state
	}

	@Test
	fun savingWithNoGatewayKeepsTheCopyAndSaysItIsLocal() {
		val (ops, state) = opsOver(listOf(book("b", name = "Zebra"), book("a", name = "Apple")))

		assertEquals(RunbookSaved.Local, kotlinx.coroutines.runBlocking { ops.save(book("c", name = "Apple")) })
		assertEquals(listOf("a", "c", "b"), state.value.runbooks.map { it.id })

		kotlinx.coroutines.runBlocking { ops.save(book("a", name = "Apple", revision = 4L)) }
		assertEquals(4L, state.value.runbooks.first { it.id == "a" }.revision)
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
		val state = MutableStateFlow(ChatState())
		val ops = RunbookOps(state, host)

		val first = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L)) }
		assertEquals(RunbookSaved.Stored, first)
		// Sent no base, since nothing was stored yet, and took back what the gateway named.
		assertEquals(null, host.fake.puts[0].second)
		assertEquals(1L, state.value.runbooks.first { it.id == "a" }.revision)

		val second = kotlinx.coroutines.runBlocking { ops.save(book("a", name = "Two", revision = 1L), baseRevision = 1L) }
		assertEquals(RunbookSaved.Stored, second)
		assertEquals(1L, host.fake.puts[1].second)
		assertEquals(2L, state.value.runbooks.first { it.id == "a" }.revision)
	}

	@Test
	fun aRetryOfAnAnswerThatWasLostIsNotASecondEdit() {
		val host = WithGateway()
		val ops = RunbookOps(MutableStateFlow(ChatState()), host)
		kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L)) }

		// The editor never heard, so it names the base it read rather than the one now stored.
		val again = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L), baseRevision = null) }
		assertEquals(RunbookSaved.Stored, again)
		assertEquals(1L, host.fake.stored.getValue("gw").getValue("a").revision)
	}

	@Test
	fun aSaveTheGatewayRefusesLeavesTheLibraryAlone() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState())
		val ops = RunbookOps(state, host)
		kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 1L)) }

		val refused = kotlinx.coroutines.runBlocking {
			ops.save(book("a", name = "Stale", revision = 1L), baseRevision = 7L)
		}
		assertEquals(true, refused is RunbookSaved.Refused)
		assertEquals("a", state.value.runbooks.first { it.id == "a" }.name)
	}

	@Test
	fun anEditInProgressOutlivesTheScreenThatWasTypingIt() {
		val (ops, _) = opsOver(listOf(book("a")))
		val typed = com.atelier_nyaarium.switchboard.runbooks.RunbookDraft(id = "a", name = "Half typed")

		ops.keepDraft("a", typed)
		// What a recreated editor asks for, holding nothing of its own.
		assertEquals(typed, ops.draftFor("a"))

		ops.dropDraft("a")
		assertEquals(null, ops.draftFor("a"))
	}

	@Test
	fun deletingTakesItOutOfTheLibraryEvenWithNoGatewayToTell() {
		val (ops, state) = opsOver(listOf(book("a"), book("b")))
		kotlinx.coroutines.runBlocking { ops.delete("a") }
		assertEquals(listOf("b"), state.value.runbooks.map { it.id })
	}

	@Test
	fun aGatewayThatKeepsItKeepsThePhonesCopyToo() {
		val host = WithGateway()
		val state = MutableStateFlow(ChatState())
		val ops = RunbookOps(state, host)
		host.library.merge(host.homeGatewayId(), listOf(book("a")))

		// The Gateway holds no such id, so it answers no, and the owner is not shown a library that
		// lost what the Gateway may still have.
		kotlinx.coroutines.runBlocking {
			assertEquals(false, ops.delete("a"))
			assertEquals(listOf("a"), host.library.all(host.homeGatewayId()).map { it.id })
		}
	}

	@Test
	fun aRefusedPushStandsUntilAPutIsTaken() {
		val refused = ConsoleRunbookPutResult(stored = false, revision = 7L, reason = "held newer")
		val raised = refusalsAfterPut(emptyMap(), "a", refused)
		assertEquals(SaveRefusal("held newer", 7L), raised["a"])

		assertEquals(raised, refusalsAfterPut(raised, "a", null))
		assertEquals(emptyMap<String, SaveRefusal>(), refusalsAfterPut(raised, "a", refused.copy(stored = true)))
	}

	@Test
	fun aSaveTheLibraryDidNotTakeIsRefusedRatherThanSilentlyLost() {
		val (ops, _) = opsOver(listOf(book("a", revision = 4L)))

		val saved = kotlinx.coroutines.runBlocking { ops.save(book("a", revision = 4L).copy(body = "stale")) }
		assertEquals(RunbookSaved.Refused(SaveRefusal("This phone holds a newer copy", 4L)), saved)
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
			ops.fire("a", emptyMap(), com.atelier_nyaarium.switchboard.proto.RunbookFireTarget.Session("host.x"), 1L)
		}
		assertEquals(null, answer)
	}
}
