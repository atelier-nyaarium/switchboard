package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackOpsTest {
	private class FakePlayback(var locked: Boolean = false) : PlaybackPort {
		override val stts = SttsPlayer(File("/tmp/switchboard-playback"))
		override fun sttsClient(): SttsClient? = null
		override fun currentProvider(): SttsProvider? = null
		override fun sttsVoiceFor(providerId: String) = ""
		override val sttsVolume = 100
		override val sttsChimeVolume = 100
		override val sttsAutoPlay = "off"
		override fun sttsReady() = false
		override fun deviceLocked() = locked
	}

	@Test
	fun pauseKeepsEveryMessageThatWasQueued() = runBlocking {
		val team = "local.gw.host.session"
		val state = MutableStateFlow(ChatState(openTabs = listOf(team), threads = mapOf(team to listOf(Message(false, "one", 1L), Message(false, "two", 2L)))))
		val playback = FakePlayback()
		val ops = PlaybackOps(state, CoroutineScope(Dispatchers.Unconfined), playback, object : PlaybackOpsCollaborators {
			override fun openThread(team: String) = team
		})
		// The player has no client, so unheld it fails the whole run before the pause.
		val held = CountDownLatch(1)
		playback.stts.post { held.await() }

		ops.enqueueForPlay(team, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = true)
		ops.enqueueForPlay(team, 2L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = true)
		ops.pausePlayback()
		val queued = ops.queueRows().map { it.entry.at }
		val paused = ops.transportState().second
		held.countDown()

		assertEquals(listOf(1L, 2L), queued)
		assertEquals(true, paused)
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

	private fun opsOver(state: MutableStateFlow<ChatState>, playback: FakePlayback) =
		PlaybackOps(state, CoroutineScope(Dispatchers.Unconfined), playback, object : PlaybackOpsCollaborators {
			override fun openThread(team: String) = team
		})

	private fun tiers(ops: PlaybackOps) = ops.queueRows().map { it.entry.team to it.entry.tier }

	@Test
	fun aLockedRunSpeaksTheAssistantInItsLockedTierAndAdvancesPastIt() = runBlocking {
		val playback = FakePlayback(locked = true)
		val ops = opsOver(lockState(), playback)
		val held = CountDownLatch(1)
		playback.stts.post { held.await() }

		ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		ops.enqueueForPlay(worker, 2L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		val queued = tiers(ops)
		held.countDown()
		// Missing voice retries twice.
		val failed = withTimeout(5_000L) {
			var rows = ops.failedRows()
			while (rows.size < 2) {
				delay(20L)
				rows = ops.failedRows()
			}
			rows.map { it.entry.team to it.entry.tier }.toSet()
		}

		assertEquals(listOf(assistant to SttsPlayer.Tier.LOCKED, worker to SttsPlayer.Tier.FULL), queued)
		assertEquals(setOf(assistant to SttsPlayer.Tier.LOCKED, worker to SttsPlayer.Tier.FULL), failed)
	}

	@Test
	fun aLockMidSpeechSwitchesToTheLockedFormAndAnUnlockReplaysNothing() = runBlocking {
		val playback = FakePlayback(locked = false)
		val ops = opsOver(lockState(), playback)
		val held = CountDownLatch(1)
		playback.stts.post { held.await() }

		ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)
		val unlocked = tiers(ops) to ops.speaksUnlockedAssistant()
		playback.locked = true
		ops.relock()
		val locked = tiers(ops) to ops.speaksUnlockedAssistant()
		playback.locked = false
		ops.relock()
		val again = tiers(ops) to ops.speaksUnlockedAssistant()
		held.countDown()

		assertEquals(listOf(assistant to SttsPlayer.Tier.FULL) to true, unlocked)
		assertEquals(listOf(assistant to SttsPlayer.Tier.LOCKED) to false, locked)
		assertEquals(locked, again)
	}

	@Test
	fun aQuietRowIsNeverQueued() = runBlocking {
		val state = lockState()
		state.value = state.value.copy(
			threads = state.value.threads + (assistant to listOf(Message(false, "sent on", 3L, isPeer = true, quiet = true))),
		)
		val ops = opsOver(state, FakePlayback())

		ops.enqueueForPlay(assistant, 3L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false)

		assertEquals(emptyList<Pair<String, SttsPlayer.Tier?>>(), tiers(ops) + ops.failedRows().map { it.entry.team to it.entry.tier })
	}

	@Test
	fun theAssistantIsFollowedWithoutATab() = runBlocking {
		val assistant = "local.gw.host.assistant"
		val stranger = "local.gw.host.other"
		val state = MutableStateFlow(
			ChatState(
				teams = listOf(Team(assistant, Presence.ended(), role = ASSISTANT_ROLE)),
				threads = mapOf(assistant to listOf(Message(false, "one", 1L)), stranger to listOf(Message(false, "two", 2L))),
			),
		)
		val ops = PlaybackOps(state, CoroutineScope(Dispatchers.Unconfined), FakePlayback(), object : PlaybackOpsCollaborators {
			override fun openThread(team: String) = team
		})

		ops.enqueueForPlay(assistant, 1L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = true)
		ops.enqueueForPlay(stranger, 2L, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = true)
		ops.pausePlayback()

		assertEquals(setOf(assistant), (ops.queueRows() + ops.failedRows()).map { it.entry.team }.toSet())
	}
}
