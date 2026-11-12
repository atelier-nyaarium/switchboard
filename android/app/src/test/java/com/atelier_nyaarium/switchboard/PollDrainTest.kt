package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.AssistantRecordThread
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
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
		@Volatile override var isVisible = false
		override val autoGenerate = false
		val applied = mutableListOf<String>()
		val reads = mutableListOf<JsonObject>()
		var dispatched = 0
		var linkNow = ConsoleLink.POLL
		override fun link() = linkNow
		@Volatile var routineRefreshes = 0
		override suspend fun refreshRoutines() {
			routineRefreshes += 1
		}
		@Volatile var enrollTicks = 0
		override suspend fun tickEnrollments() {
			enrollTicks += 1
		}
		var planned: ConsoleTransportPlan? = null
		override fun plan(visible: Boolean, failed: Boolean): ConsoleTransportPlan = planned ?: error("unused")
		override fun fromCanonical(value: String) = value
		val forgotten = mutableSetOf<String>()
		override fun isForgotten(team: String) = team in forgotten
		override fun advanceMailbox(result: SyncPollResult<Drained>) = SyncAdvance(SyncCursor.initial(), result.entries, false)
		override fun markCommsActivity(now: Long) = Unit
		override fun reconcileSent(team: String, message: Message) = Unit
		val appended = mutableListOf<Pair<String, Message>>()
		override fun appendInbound(team: String, message: Message, beforeCommit: () -> Unit): Boolean {
			appended += team to message
			return true
		}
		var autoTier: SttsPlayer.Tier? = null
		var sttsReady = false
		val played = mutableListOf<Long>()
		override fun autoPlayTier(): SttsPlayer.Tier? = autoTier
		override fun isSttsReady() = sttsReady
		val inbound = mutableListOf<Pair<String, List<Message>>>()
		override fun onInbound(team: String, messages: List<Message>) {
			inbound += team to messages
		}
		val launchAlerts = mutableListOf<Pair<String, String>>()
		override fun onLaunchFailed(team: String, line: String) {
			launchAlerts += team to line
		}
		/** What was durable when the cursor moved. */
		var heldAtCommit: Map<String, LaunchError>? = null
		private val durable = mutableMapOf<String, LaunchError>()
		override fun holdLaunchError(team: String, error: LaunchError): Boolean {
			val held = state.holdLaunchError(team, error)
			if (held) durable[team] = error
			return held
		}
		override fun preloadMessage(team: String, at: Long) = Unit
		override suspend fun enqueueForPlay(team: String, at: Long, tier: SttsPlayer.Tier) {
			played += at
		}
		override fun commitMailbox(cursor: SyncCursor) {
			heldAtCommit = durable.toMap()
		}
		override fun decodeAttachments(files: List<ChannelFile>?) = emptyList<MessageFile>()
		override fun fetchPendingAttachments() = Unit
		override suspend fun dispatchInboxRows(rows: List<InboxRow>) { dispatched += rows.size }
		override suspend fun applyPlane(name: String, lineage: PlaneLineage, payload: JsonElement?): Boolean {
			drainGate.withDrainMutex { applied += "$name@${lineage.epoch}/${lineage.version}" }
			return true
		}
		var polled: TickOutcome? = null
		override suspend fun poll(known: Map<String, HeldLineage>, observe: () -> Long): TickOutcome = polled ?: error("unused")

		/** Router serves newer planes. */
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
	fun autoPlaySpeaksAnAgentRowAndNeverTwoSessionsTalking() = runBlocking {
		val session = Address.of("dom", "gw", "host", "abc")
		val host = FakeHost(emptyMap()).apply {
			autoTier = SttsPlayer.Tier.FULL
			sttsReady = true
			state.value = ChatState(openTabs = listOf(session.canonical))
		}
		val drain = PollDrain(host, IdlePresencePort)
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
		val row = { seq: Long, kind: String ->
			MailboxEntry(
				seq = seq,
				at = seq,
				kind = kind,
				session_id = storeKey(SessionKey.Conv("owner", session)),
				from = "dom.gw.other.x",
				to = session.canonical,
				body = "hello",
			)
		}

		try {
			drain.start(scope)
			drain.processEntries(listOf(row(1L, "peer"), row(2L, "reply"), row(3L, "peer")), cursor = 3L, epoch = 1L, dropped = 0L)
			assertEquals(listOf(2L), host.played)
			assertEquals(listOf(1L, 2L, 3L), host.inbound.single().second.map { it.seq })
		} finally {
			drain.stopAndJoin()
			scope.cancel()
		}
	}

	@Test
	fun aQuietRecordLandsWithNoBodyAndAlertsNothing() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val session = Address.of("dom", "gw", "host", "assistant")
		val record = { seq: Long, notify: Boolean, body: String? ->
			MailboxEntry(
				seq = seq,
				at = seq,
				kind = ASSISTANT_RECORD_KIND,
				session_id = storeKey(SessionKey.Conv("owner", session)),
				body = body,
				notify = notify,
				threads = listOf(AssistantRecordThread(threadId = "$seq", outcome = "done")),
			)
		}

		drain.processEntries(listOf(record(1L, false, null)), cursor = 1L, epoch = 1L, dropped = 0L)
		val quietOnly = host.inbound.toList()
		drain.processEntries(listOf(record(2L, true, "Worth a look."), record(3L, false, null)), cursor = 3L, epoch = 1L, dropped = 0L)

		assertEquals(listOf(1L, 2L, 3L), host.appended.map { it.second.seq })
		assertEquals(emptyList<Pair<String, List<Message>>>(), quietOnly)
		assertEquals(listOf(listOf(2L)), host.inbound.map { (_, messages) -> messages.map { it.seq } })
	}

	@Test
	fun aLaunchsStartedLineLandsQuietlyAndItsFailureAlerts() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val session = Address.of("dom", "gw", "app", "new")
		val outcome = { seq: Long, body: String, title: String? ->
			MailboxEntry(
				seq = seq,
				at = seq,
				kind = "notice",
				session_id = storeKey(SessionKey.Notice(session)),
				from = session.canonical,
				body = body,
				title = title,
			)
		}

		drain.processEntries(listOf(outcome(1L, "Session started.", null)), cursor = 1L, epoch = 1L, dropped = 0L)
		val startedAlerts = host.inbound.toList()
		drain.processEntries(
			listOf(outcome(2L, "Devcontainer failed to start.", "Devcontainer failed to start")),
			cursor = 2L,
			epoch = 1L,
			dropped = 0L,
		)

		assertEquals(listOf(1L, 2L), host.appended.map { it.second.seq })
		assertEquals(true, host.appended.first().second.isQuiet())
		assertEquals(emptyList<Pair<String, List<Message>>>(), startedAlerts)
		assertEquals(listOf(listOf(2L)), host.inbound.map { (_, messages) -> messages.map { it.seq } })
	}

	@Test
	fun aFailedLaunchsRowIsHeldAndAlertsWithoutThreadingARow() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val session = Address.of("dom", "gw", "app", "new")
		val row = MailboxEntry(
			seq = 1L,
			at = 1L,
			kind = "notice",
			session_id = storeKey(SessionKey.Notice(session)),
			from = session.canonical,
			body = "Devcontainer failed to start.",
			title = "Devcontainer failed to start",
			launch = "failed",
		)

		drain.processEntries(listOf(row), cursor = 1L, epoch = 1L, dropped = 0L)

		assertEquals(emptyList<Pair<String, Message>>(), host.appended)
		assertEquals(emptyList<Pair<String, List<Message>>>(), host.inbound)
		val held = mapOf(session.canonical to LaunchError("Devcontainer failed to start.", 1L))
		assertEquals(listOf(session.canonical to "Devcontainer failed to start."), host.launchAlerts)
		assertEquals(held, host.state.value.launchErrors)
		assertEquals(held, host.heldAtCommit)
	}

	@Test
	fun aForgottenSessionsRowsLandNothing() = runBlocking {
		val host = FakeHost(emptyMap())
		val drain = PollDrain(host, IdlePresencePort)
		val actions = mutableListOf<String>()
		drain.addPluginActionSubscriber { team, _, _, _, _ -> actions += team }
		val gone = Address.of("dom", "gw", "host", "gone")
		val kept = Address.of("dom", "gw", "host", "kept")
		host.forgotten += gone.canonical
		fun row(seq: Long, to: Address, kind: String) = MailboxEntry(
			seq = seq,
			at = seq,
			kind = kind,
			session_id = storeKey(SessionKey.Conv("owner", to)),
			body = "hello",
			pluginId = "vault",
			actionType = "request",
		)

		drain.processEntries(
			listOf(row(1, gone, "agent"), row(2, gone, "plugin_action"), row(3, kept, "agent")),
			cursor = 3L,
			epoch = 1L,
			dropped = 0L,
		)

		assertEquals(listOf(kept.canonical), host.appended.map { it.first })
		assertEquals(emptyList<String>(), actions)
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

		// Full reads preserve cursors.
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

	@Test
	fun onlyARowProducedAfterTheAppCameForwardFollows() {
		val since = 10_000L
		assertEquals(true, arrivedWhileVisible(visible = true, at = since + 5_000L, foregroundSince = since))
		assertEquals(true, arrivedWhileVisible(visible = true, at = since, foregroundSince = since))
		// Backlog after resume.
		assertEquals(false, arrivedWhileVisible(visible = true, at = since - 1L, foregroundSince = since))
		assertEquals(false, arrivedWhileVisible(visible = false, at = since + 5_000L, foregroundSince = since))
		assertEquals(false, arrivedWhileVisible(visible = true, at = since, foregroundSince = 0L))
	}

	@Test
	fun visiblePollRefreshesRoutinesOncePerInterval() = runBlocking {
		val host = FakeHost(emptyMap()).apply { isVisible = true }
		val clock = AtomicLong(100_000L)
		val drain = PollDrain(host, IdlePresencePort, clockMillis = clock::get)
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })

		try {
			drain.start(scope)
			withTimeout(2_000L) {
				while (host.routineRefreshes < 1) delay(1L)
			}

			clock.addAndGet(VISIBLE_ROUTINE_REFRESH_MS - 1L)
			repeat(3) { drain.kickPoll() }
			delay(100L)
			assertEquals(1, host.routineRefreshes)

			clock.incrementAndGet()
			drain.kickPoll()
			withTimeout(2_000L) {
				while (host.routineRefreshes < 2) delay(1L)
			}
			assertEquals(2, host.routineRefreshes)
		} finally {
			drain.stopAndJoin()
			scope.cancel()
		}
	}

	@Test
	fun everyPathOfTheLoopTicksUnfinishedSetups() = runBlocking {
		for ((visible, link) in listOf(true to ConsoleLink.SOCKET, false to ConsoleLink.SOCKET, false to ConsoleLink.POLL)) {
			val host = FakeHost(emptyMap()).apply {
				isVisible = visible
				linkNow = link
				planned = ConsoleTransportPlan(PollWait.Delay(5L))
				polled = TickOutcome(0, 0, false, emptyMap())
			}
			val drain = PollDrain(host, IdlePresencePort)
			val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
			try {
				drain.start(scope)
				withTimeout(2_000L) {
					while (host.enrollTicks < 1) delay(1L)
				}
			} finally {
				drain.stopAndJoin()
				scope.cancel()
			}
		}
	}
}
