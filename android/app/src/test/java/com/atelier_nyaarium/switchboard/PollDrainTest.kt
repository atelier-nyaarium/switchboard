package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.OpKey
import com.atelier_nyaarium.switchboard.proto.PlaneLineage
import com.atelier_nyaarium.switchboard.proto.PlaneRead
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.RowOrigin
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.SyncAdvance
import com.atelier_nyaarium.switchboard.proto.SyncCursor
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.storeKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class PollDrainTest {
	private class FakeHost(var router: Map<String, PlaneRead>) : DrainHost {
		override val drainGate = DrainGate()
		override val state = MutableStateFlow(ChatState())
		override val isVisible = false
		override val autoGenerate = false
		val applied = mutableListOf<String>()
		val reads = mutableListOf<JsonObject>()
		var dispatched = 0
		override fun link() = ConsoleLink.POLL
		var routineRefreshes = 0
		override suspend fun refreshRoutines() {
			routineRefreshes += 1
		}
		override fun plan(visible: Boolean, failed: Boolean): ConsoleTransportPlan = error("unused")
		override fun fromCanonical(value: String) = value
		override fun advanceMailbox(result: SyncPollResult<Drained>) = SyncAdvance(SyncCursor.initial(), result.entries, false)
		override fun setGap(value: Boolean) = Unit
		override fun markCommsActivity(now: Long) = Unit
		override fun reconcileSent(team: String, message: Message) = Unit
		val appended = mutableListOf<Pair<String, Message>>()
		override fun appendInbound(team: String, message: Message, beforeCommit: () -> Unit): Boolean {
			appended += team to message
			return true
		}
		override fun autoPlayTier(): SttsPlayer.Tier? = null
		override fun isSttsReady() = false
		override fun onInbound(team: String, messages: List<Message>) = Unit
		override fun preloadMessage(team: String, at: Long) = Unit
		override suspend fun enqueueForPlay(team: String, at: Long, tier: SttsPlayer.Tier) = Unit
		override fun commitMailbox(cursor: SyncCursor) = Unit
		override fun decodeAttachments(files: List<ChannelFile>?) = emptyList<MessageFile>()
		override fun fetchPendingAttachments() = Unit
		override suspend fun dispatchInboxRows(rows: List<InboxRow>) { dispatched += rows.size }
		override suspend fun applyPlane(name: String, lineage: PlaneLineage, payload: JsonElement?): Boolean {
			drainGate.withDrainMutex { applied += "$name@${lineage.epoch}/${lineage.version}" }
			return true
		}
		override suspend fun poll(known: Map<String, HeldLineage>, observe: () -> Long): TickOutcome = error("unused")

		/** The Router's rule: served unless held at this lineage and version or past it. */
		override suspend fun readPlanes(held: JsonObject): List<PlaneRead> {
			reads += held
			return router.values.filter { plane ->
				val known = held[plane.name]?.let { wireJson.decodeFromJsonElement(PlaneLineage.serializer(), it) }
				known == null || known.epoch != plane.lineage.epoch || plane.lineage.version > known.version
			}
		}
	}

	private fun lineage(epoch: Long, version: Long) = PlaneLineage(epoch, version)

	private fun welcome(vararg planes: Pair<String, PlaneLineage>) = buildJsonObject {
		planes.forEach { (name, it) -> put(name, wireJson.encodeToJsonElement(PlaneLineage.serializer(), it)) }
	}

	@Test
	fun aRowThreadsUnderItsOwnAddressWhoeverSentIt() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val session = Address.of("dom", "gw", "host", "abc")
		val peer = MailboxEntry(
			seq = 1L,
			at = 1L,
			kind = "peer",
			session_id = storeKey(SessionKey.Conv("owner", session)),
			from = "dom.gw.other.x",
			to = session.canonical,
			body = "hello",
		)
		val notice = MailboxEntry(
			seq = 2L,
			at = 2L,
			kind = "notice",
			session_id = storeKey(SessionKey.Notice(Address.of("dom", "gw", "host", "def"))),
			body = "done",
		)
		drain.processEntries(listOf(peer, notice), cursor = 2L, epoch = 1L, dropped = 0L)
		assertEquals(listOf(session.canonical, "dom.gw.host.def"), host.appended.map { it.first })
		assertEquals(true, host.appended.first().second.isPeer)
	}

	@Test
	fun nestedPlaneApplicationDoesNotBlockFollowingRows() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val row = InboxRow(RowEnvelope(RowOrigin("owner", "domain"), OpKey("team", "op"), JsonPrimitive("clear"), "kind", emptyList()), "sig", JsonPrimitive("body"), 1L, 1L, 1L)
		drain.withDrainMutex {
			drain.applyPlane("presence", lineage(1, 1), JsonPrimitive("payload"))
			host.dispatchInboxRows(listOf(row))
		}
		assertEquals(listOf("presence@1/1"), host.applied)
		assertEquals(1, host.dispatched)
	}

	@Test
	fun welcomeFetchesOnlyWhenItNamesAPlanePastTheCursor() = runBlocking {
		val host = FakeHost(
			mapOf(
				"presence" to PlaneRead("presence", lineage(1, 2), JsonPrimitive("roster")),
				"taskBoard" to PlaneRead("taskBoard", lineage(1, 1), JsonPrimitive("board")),
			),
		)
		val drain = PollDrain(host, IdlePresencePort)
		drain.applyWelcomePlanes(welcome("presence" to lineage(1, 2), "taskBoard" to lineage(1, 1)))
		drain.applyWelcomePlanes(welcome("presence" to lineage(1, 2), "taskBoard" to lineage(1, 0)))
		assertEquals(listOf(buildJsonObject {}), host.reads)
		assertEquals(listOf("presence@1/2", "taskBoard@1/1"), host.applied)
		assertEquals(welcome("presence" to lineage(1, 2), "taskBoard" to lineage(1, 1)), drain.knownPlanesJson())

		drain.applyWelcomePlanes(welcome("presence" to lineage(1, 3)))
		assertEquals(2, host.reads.size)
		assertEquals(listOf("presence@1/2", "taskBoard@1/1"), host.applied)

		// Asking for everything re-reads; the cursor still holds what it landed.
		drain.pullPlanes(everything = true)
		assertEquals(3, host.reads.size)
		assertEquals(buildJsonObject {}, host.reads.last())
		assertEquals(listOf("presence@1/2", "taskBoard@1/1"), host.applied)

		drain.resetPlaneCursors()
		drain.applyWelcomePlanes(welcome("presence" to lineage(1, 2), "taskBoard" to lineage(1, 1)))
		assertEquals(4, host.reads.size)
		assertEquals(listOf("presence@1/2", "taskBoard@1/1", "presence@1/2", "taskBoard@1/1"), host.applied)
	}

	@Test
	fun aPlaneFromAnotherLineageLandsWhateverItsVersion() = runBlocking {
		val host = FakeHost(mapOf("presence" to PlaneRead("presence", lineage(1, 9), JsonPrimitive("roster"))))
		val drain = PollDrain(host, IdlePresencePort)
		drain.applyWelcomePlanes(welcome("presence" to lineage(1, 9)))
		drain.applyPlane("presence", lineage(1, 4), JsonPrimitive("late"))
		assertEquals(listOf("presence@1/9"), host.applied)

		host.router = mapOf("presence" to PlaneRead("presence", lineage(2, 1), JsonPrimitive("reborn")))
		drain.applyWelcomePlanes(welcome("presence" to lineage(2, 1)))
		assertEquals(listOf("presence@1/9", "presence@2/1"), host.applied)
		assertEquals(welcome("presence" to lineage(2, 1)), drain.knownPlanesJson())
	}

	@Test
	fun aPlaneObservedBeforeTheOneThatLandedIsBehind() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val early = drain.observe()
		val late = drain.observe()
		drain.applyPlane("presence", lineage(2, 1), JsonPrimitive("new"), late)
		drain.applyPlane("presence", lineage(1, 50), JsonPrimitive("old"), early)
		assertEquals(listOf("presence@2/1"), host.applied)
	}
}
