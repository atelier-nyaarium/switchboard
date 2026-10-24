package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SttsDefaults
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackOpsTest {
	/** Holds synthesis requests open. */
	private class SilentServer : AutoCloseable {
		private val socket = java.net.ServerSocket(0)
		private val held = CopyOnWriteArrayList<java.net.Socket>()
		val url = "http://127.0.0.1:${socket.localPort}"

		init {
			Thread {
				while (!socket.isClosed) runIsolated { held += socket.accept() }
			}.apply { isDaemon = true }.start()
		}

		override fun close() {
			runIsolated { socket.close() }
			held.forEach { runIsolated { it.close() } }
		}
	}

	/** The JVM cannot play audio, so a body is seen by its claim. */
	private class FakePlayback(var locked: Boolean = false, gapMs: Long = SttsPlayer.MARKER_GAP_MS) : PlaybackPort {
		val root = File.createTempFile("switchboard-playback", "test").apply { delete(); mkdirs() }
		override val stts = SttsPlayer(root, gapMs)

		/** Runs at a marker's terminal, before `PlaybackOps` hears it. */
		@Volatile
		var onMarkerEnded: (() -> Unit)? = null
		private val server = SilentServer()
		val client = SttsClient(server.url, "test-key")
		val provider = SttsProvider(
			id = "test",
			label = "Test",
			path = "test",
			hasSample = false,
			request = buildJsonObject { put("text", "\$text") },
			defaults = SttsDefaults("voice"),
			voices = emptyList(),
			voiceHint = "voice",
		)
		val events = CopyOnWriteArrayList<Event>()
		// Registered before PlaybackOps, so it hears every event first.
		private val listener = stts.addListener {
			events += it
			if (it is Event.Ended && it.team == SttsPlayer.MARKER_TEAM) onMarkerEnded?.invoke()
		}

		override fun sttsClient() = client
		override fun currentProvider() = provider
		override fun sttsVoiceFor(providerId: String) = "voice"
		override val sttsVolume = 100
		override val sttsChimeVolume = 100
		override val sttsAutoPlay = "off"
		override fun sttsReady() = true
		override fun deviceLocked() = locked

		/** Cached markers finish; bodies synthesize. */
		fun seed(state: ChatState, team: String, at: Long) {
			val msg = state.threads[team]?.firstOrNull { it.at == at && !it.fromMe } ?: return
			val voice = "voice"
			val marker = sentinelText(state, msg, team)
			val markerAt = stts.cache.markerAt(marker, provider, voice)
			val markerFile = File(
				File(root, "stts/${SttsPlayer.MARKER_TEAM}"),
				"$markerAt-${provider.path}-${stts.cache.safeVoice(voice)}.audio",
			)
			markerFile.parentFile?.mkdirs()
			markerFile.writeBytes(byteArrayOf(1))
		}

		fun claimed(team: String, at: Long, tier: SttsPlayer.Tier): Boolean = stts.isClaimed(team, at, tier)

		fun ends(team: String, at: Long, tier: SttsPlayer.Tier) = events
			.filterIsInstance<Event.Ended>()
			.filter { it.team == team && it.at == at && it.tier == tier }

		fun close() {
			stts.removeListener(listener)
			server.close()
			root.deleteRecursively()
		}
	}

	private inner class Fixture(val state: MutableStateFlow<ChatState>, locked: Boolean = false, gapMs: Long = SttsPlayer.MARKER_GAP_MS) {
		val playback = FakePlayback(locked, gapMs)
		private val scope = CoroutineScope(
			SupervisorJob() + Dispatchers.Unconfined + CoroutineExceptionHandler { _, _ -> },
		)
		val ops = PlaybackOps(state, scope, playback, object : PlaybackOpsCollaborators {
			override fun openThread(team: String) = team
		})

		fun close() {
			scope.cancel()
			playback.close()
		}
	}

	private val fixtures = mutableListOf<Fixture>()

	@After
	fun closeFixtures() {
		fixtures.forEach { it.close() }
		fixtures.clear()
	}

	private fun fixture(state: MutableStateFlow<ChatState>, locked: Boolean = false, gapMs: Long = SttsPlayer.MARKER_GAP_MS) =
		Fixture(state, locked, gapMs).also(fixtures::add)

	private suspend fun awaitThat(f: Fixture, what: String, check: () -> Boolean) {
		try {
			withTimeout(5_000L) { while (!check()) delay(10L) }
		} catch (e: kotlinx.coroutines.TimeoutCancellationException) {
			throw AssertionError("never $what; events: ${f.playback.events}", e)
		}
	}

	private suspend fun awaitClaimed(f: Fixture, team: String, at: Long, tier: SttsPlayer.Tier) =
		awaitThat(f, "claimed $team@$at $tier") { f.playback.claimed(team, at, tier) }

	private suspend fun awaitEnd(f: Fixture, team: String, at: Long, tier: SttsPlayer.Tier, outcome: SttsPlayer.Outcome) =
		awaitThat(f, "ended $team@$at $tier $outcome") {
			f.playback.ends(team, at, tier).any { it.outcome == outcome }
		}

	private val assistant = "local.gw.host.assistant"
	private val worker = "local.gw.host.worker"

	private fun lockState() = MutableStateFlow(
		ChatState(
			openTabs = listOf(worker),
			teams = listOf(Team(assistant, Presence.ended(), role = ASSISTANT_ROLE)),
			threads = mapOf(
				assistant to listOf(Message(false, "private body", 1L, title = "Safe title")),
				worker to listOf(Message(false, "worker body", 2L)),
			),
		),
	)

	private fun tiers(ops: PlaybackOps) = ops.queueRows().map { it.entry.team to it.entry.tier }

	@Test
	fun pauseKeepsEveryMessageThatWasQueued() = runBlocking {
		val team = "local.gw.host.session"
		val state = MutableStateFlow(
			ChatState(
				openTabs = listOf(team),
				threads = mapOf(team to listOf(Message(false, "one", 1L), Message(false, "two", 2L))),
			),
		)
		val f = fixture(state)
		f.playback.seed(state.value, team, 1L)
		f.playback.seed(state.value, team, 2L)

		f.ops.enqueueForPlay(team, 1L, SttsPlayer.Tier.FULL, announceRun = false)
		f.ops.enqueueForPlay(team, 2L, SttsPlayer.Tier.FULL, announceRun = false)
		f.ops.pausePlayback()

		assertEquals(listOf(1L, 2L), f.ops.queueRows().map { it.entry.at })
		assertTrue(f.ops.transportState().second)
	}

	@Test
	fun aLockedRunClaimsTheAssistantInItsLockedTierAndAdvancesPastIt() = runBlocking {
		val state = lockState()
		val f = fixture(state, locked = true)
		f.playback.seed(state.value, assistant, 1L)
		f.playback.seed(state.value, worker, 2L)

		f.ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		f.ops.enqueueForPlay(worker, 2L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		awaitClaimed(f, assistant, 1L, SttsPlayer.Tier.LOCKED)
		val queued = tiers(f.ops)
		// Marker precedes body claim.
		val markerEnded = f.playback.events.any { it is Event.Ended && it.team == SttsPlayer.MARKER_TEAM }
		f.ops.skipPlayback()
		awaitEnd(f, assistant, 1L, SttsPlayer.Tier.LOCKED, SttsPlayer.Outcome.PREEMPTED)
		awaitClaimed(f, worker, 2L, SttsPlayer.Tier.FULL)

		assertEquals(listOf(assistant to SttsPlayer.Tier.LOCKED, worker to SttsPlayer.Tier.FULL), queued)
		assertTrue(markerEnded)
		assertTrue(f.playback.ends(assistant, 1L, SttsPlayer.Tier.FULL).isEmpty())
	}

	@Test
	fun aLockMidSpeechSwitchesToTheLockedFormAndAnUnlockReplaysNothing() = runBlocking {
		val f = fixture(lockState())
		f.playback.seed(f.state.value, assistant, 1L)
		f.ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		awaitClaimed(f, assistant, 1L, SttsPlayer.Tier.FULL)
		val unlocked = f.ops.speaksUnlockedAssistant()

		f.playback.locked = true
		f.ops.relock()
		awaitEnd(f, assistant, 1L, SttsPlayer.Tier.FULL, SttsPlayer.Outcome.PREEMPTED)
		awaitClaimed(f, assistant, 1L, SttsPlayer.Tier.LOCKED)
		f.playback.locked = false
		f.ops.relock()
		delay(100L)

		assertTrue(unlocked)
		assertTrue(f.playback.claimed(assistant, 1L, SttsPlayer.Tier.LOCKED))
		assertFalse(f.playback.claimed(assistant, 1L, SttsPlayer.Tier.FULL))
		assertTrue(f.playback.ends(assistant, 1L, SttsPlayer.Tier.LOCKED).isEmpty())
		assertFalse(f.ops.speaksUnlockedAssistant())
	}

	@Test
	fun aLockInTheGapAfterTheAnnouncementSpeaksTheLockedLineWithoutAnnouncingAgain() = runBlocking {
		// A gap no scheduler delay can outlast.
		val f = fixture(lockState(), gapMs = 60_000L)
		f.playback.seed(f.state.value, assistant, 1L)
		val markerEnds = { f.playback.events.count { it is Event.Ended && it.team == SttsPlayer.MARKER_TEAM } }

		f.ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		awaitThat(f, "the announcement ended") { markerEnds() == 1 }
		f.playback.locked = true
		f.ops.relock()
		awaitClaimed(f, assistant, 1L, SttsPlayer.Tier.LOCKED)
		delay(500L)

		assertEquals(1, markerEnds())
		assertTrue(f.playback.ends(assistant, 1L, SttsPlayer.Tier.FULL).isEmpty())
		assertTrue(f.playback.claimed(assistant, 1L, SttsPlayer.Tier.LOCKED))
	}

	@Test
	fun aLockAtTheAnnouncementsEndBeforeItIsHandledStillAnnouncesOnce() = runBlocking {
		val f = fixture(lockState(), gapMs = 60_000L)
		f.playback.seed(f.state.value, assistant, 1L)
		val markerEnds = { f.playback.events.count { it is Event.Ended && it.team == SttsPlayer.MARKER_TEAM } }
		f.playback.onMarkerEnded = {
			f.playback.onMarkerEnded = null
			f.playback.locked = true
			runBlocking { f.ops.relock() }
		}

		f.ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		awaitClaimed(f, assistant, 1L, SttsPlayer.Tier.LOCKED)
		delay(500L)

		assertEquals(1, markerEnds())
		assertTrue(f.playback.ends(assistant, 1L, SttsPlayer.Tier.FULL).isEmpty())
	}

	@Test
	fun pauseEndsTheClaimAndResumeClaimsTheParkedHeadAgain() = runBlocking {
		val team = "local.gw.host.session"
		val state = MutableStateFlow(
			ChatState(openTabs = listOf(team), threads = mapOf(team to listOf(Message(false, "one", 1L)))),
		)
		val f = fixture(state)
		f.playback.seed(state.value, team, 1L)
		f.ops.enqueueForPlay(team, 1L, SttsPlayer.Tier.FULL, announceRun = false)
		awaitClaimed(f, team, 1L, SttsPlayer.Tier.FULL)

		f.ops.pausePlayback()
		awaitEnd(f, team, 1L, SttsPlayer.Tier.FULL, SttsPlayer.Outcome.PREEMPTED)
		val parked = f.playback.claimed(team, 1L, SttsPlayer.Tier.FULL) to f.ops.queueRows().map { it.entry.at }
		f.ops.resumePlayback()
		awaitClaimed(f, team, 1L, SttsPlayer.Tier.FULL)

		assertEquals(false to listOf(1L), parked)
		assertEquals(1, f.playback.ends(team, 1L, SttsPlayer.Tier.FULL).size)
	}

	@Test
	fun moversEndTheCurrentClaim() = runBlocking {
		val team = "local.gw.host.session"
		for (mover in listOf("skip", "drop", "team", "clear")) {
			val state = MutableStateFlow(
				ChatState(openTabs = listOf(team), threads = mapOf(team to listOf(Message(false, "one", 1L)))),
			)
			val f = fixture(state)
			f.playback.seed(state.value, team, 1L)
			f.ops.enqueueForPlay(team, 1L, SttsPlayer.Tier.FULL, announceRun = false)
			awaitClaimed(f, team, 1L, SttsPlayer.Tier.FULL)

			when (mover) {
				"skip" -> f.ops.skipPlayback()
				"drop" -> f.ops.dropFromQueue(QueueEntry(team, 1L, SttsPlayer.Tier.FULL))
				"team" -> f.ops.dropQueuedFor(team)
				"clear" -> f.ops.clearInMemory()
			}
			awaitEnd(f, team, 1L, SttsPlayer.Tier.FULL, SttsPlayer.Outcome.PREEMPTED)

			assertFalse(mover, f.playback.claimed(team, 1L, SttsPlayer.Tier.FULL))
			assertTrue(mover, f.ops.queueRows().isEmpty())
		}
	}

	@Test
	fun aPeerThatTurnsQuietWhileWaitingRetiresWithoutAClaim() = runBlocking {
		val team = "local.gw.host.session"
		val state = MutableStateFlow(
			ChatState(
				openTabs = listOf(team),
				threads = mapOf(
					team to listOf(
						Message(false, "first", 1L),
						Message(false, "peer", 2L, isPeer = true),
					),
				),
			),
		)
		val f = fixture(state)
		f.playback.seed(state.value, team, 1L)
		f.playback.seed(state.value, team, 2L)
		f.ops.enqueueForPlay(team, 1L, SttsPlayer.Tier.FULL, announceRun = false)
		f.ops.enqueueForPlay(team, 2L, SttsPlayer.Tier.FULL, announceRun = false)
		awaitClaimed(f, team, 1L, SttsPlayer.Tier.FULL)
		state.value = state.value.copy(
			threads = state.value.threads + (team to state.value.threads.getValue(team).map {
				if (it.at == 2L) it.copy(quiet = true) else it
			}),
		)

		f.playback.stts.stopMessage(team, 1L)
		awaitEnd(f, team, 1L, SttsPlayer.Tier.FULL, SttsPlayer.Outcome.STOPPED)
		awaitThat(f, "an empty queue") { f.ops.queueRows().isEmpty() }

		assertFalse(f.playback.claimed(team, 2L, SttsPlayer.Tier.FULL))
		assertTrue(f.playback.ends(team, 2L, SttsPlayer.Tier.FULL).isEmpty())
		assertTrue(f.ops.failedRows().isEmpty())
	}

	@Test
	fun aQuietRowIsNeverQueued() = runBlocking {
		val state = lockState()
		state.value = state.value.copy(
			threads = state.value.threads + (assistant to listOf(Message(false, "sent on", 3L, isPeer = true, quiet = true))),
		)
		val f = fixture(state)

		f.ops.enqueueForPlay(assistant, 3L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)

		assertEquals(emptyList<Pair<String, SttsPlayer.Tier?>>(), tiers(f.ops) + f.ops.failedRows().map { it.entry.team to it.entry.tier })
	}

	@Test
	fun theAssistantIsFollowedWithoutATab() = runBlocking {
		val stranger = "local.gw.host.other"
		val state = MutableStateFlow(
			ChatState(
				teams = listOf(Team(assistant, Presence.ended(), role = ASSISTANT_ROLE)),
				threads = mapOf(assistant to listOf(Message(false, "one", 1L)), stranger to listOf(Message(false, "two", 2L))),
			),
		)
		val f = fixture(state)
		f.playback.seed(state.value, assistant, 1L)

		f.ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false)
		f.ops.enqueueForPlay(stranger, 2L, SttsPlayer.Tier.FULL, announceRun = false)
		f.ops.pausePlayback()

		assertEquals(setOf(assistant), (f.ops.queueRows() + f.ops.failedRows()).map { it.entry.team }.toSet())
	}

	@Test
	fun onlyTheUnlockedAssistantHeadKeepsTheLockWatchActive() = runBlocking {
		val state = lockState()
		val f = fixture(state)
		f.playback.seed(state.value, worker, 2L)
		f.playback.seed(state.value, assistant, 1L)
		f.ops.enqueueForPlay(worker, 2L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		f.ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)

		assertEquals(worker, f.ops.queueRows().first().entry.team)
		assertFalse(f.ops.speaksUnlockedAssistant())
	}
}
