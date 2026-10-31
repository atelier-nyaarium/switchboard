package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SttsProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface PlaybackPort {
	val stts: SttsPlayer
	fun sttsClient(): SttsClient?
	fun currentProvider(): SttsProvider?
	fun sttsVoiceFor(providerId: String): String
	val sttsVolume: Int
	val sttsChimeVolume: Int
	val sttsAutoPlay: String
	fun sttsReady(): Boolean
	fun deviceLocked(): Boolean
}

internal interface PlaybackOpsCollaborators {
	fun openThread(team: String): String?
}

internal class PlaybackOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val playback: PlaybackPort,
	private val collaborators: PlaybackOpsCollaborators,
	private val speaksForHold: (Boolean) -> Boolean = { it },
) : ClearsOnReprovision {
	/** One mutex serializes terminals and user transport actions. */
	private val queue = PlaybackQueue { id, remember -> playback.stts.end(id, remember) }

	/** Every advance reads and mutates the head under this lock. */
	private val advanceMutex = Mutex()

	private val reads = PlaybackReadModels(state, playback, queue) { transportPaused }

	init {
		playback.stts.addListener { event ->
			if (event is Event.Ended) {
				// Generation identifies the exact request that ended.
				repoScope.launch(Dispatchers.IO) {
					onPlaybackEnded(event.team, event.outcome, event.gen, event.reason)
				}
			}
		}
	}

	private fun lockedTier(team: String, tier: SttsPlayer.Tier): SttsPlayer.Tier =
		spokenTier(isAssistant(state.value, team), playback.deviceLocked(), tier)

	fun playStatesFor(team: String): Map<Long, String> = reads.playStatesFor(team)

	fun isMessagePlaying(team: String, at: Long): Boolean = playback.stts.isPlayingMessage(team, at)

	fun stopMessage(team: String, at: Long) = playback.stts.stopMessage(team, at)

	private val pendingMarkers = ArrayDeque<Marker>()

	private var markersFor: HeadTicket? = null
	private var nextRunChime = false

	@Volatile
	private var parkedAnnounced: QueueEntry? = null

	private var markerInFlight: Long? = null

	private sealed interface Marker {
		data object Chime : Marker

		data class Spoken(val text: String) : Marker
	}

	suspend fun enqueueForPlay(
		team: String,
		at: Long,
		tier: SttsPlayer.Tier,
		announceRun: Boolean,
		requireFollowed: Boolean = true,
	) {
		val entry = QueueEntry(team, at, tier)
		advanceMutex.withLock {
			// Recheck followed state under the advance lock.
			if (requireFollowed && team !in followedTeams(state.value)) return
			// Quiet rows stay unspoken.
			if (state.value.threads[team]?.lastOrNull { it.at == at }?.isQuiet() == true) return
			if (!speaksForHold(true)) return
			val beginsRun = queue.isIdle()
			if (!queue.enqueue(entry)) return
			if (beginsRun) nextRunChime = announceRun
			resumeIfSilent()
		}
		transportChanged()
	}

	suspend fun clearForOtherHolder() {
		advanceMutex.withLock {
			markerInFlight?.let { playback.stts.abandonGeneration(it) }
			clearMarkers()
			queue.clear()
			parkedAnnounced = null
			nextRunChime = false
		}
		transportChanged()
	}

	private fun queueMarkers(ticket: HeadTicket, chime: Boolean) {
		pendingMarkers.clear()
		markersFor = ticket
		if (chime) pendingMarkers.addLast(Marker.Chime)
		val entry = ticket.entry
		val msg = state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: return
		pendingMarkers.addLast(Marker.Spoken(sentinelText(state.value, msg, entry.team)))
	}

	private fun clearMarkers() {
		pendingMarkers.clear()
		markersFor = null
		markerInFlight = null
	}

	private fun nextMarkerStarted(): Boolean {
		while (pendingMarkers.isNotEmpty()) {
			val started = when (val marker = pendingMarkers.removeFirst()) {
				is Marker.Chime -> chimeSource?.invoke()?.let { playback.stts.playChime(it, playback.sttsChimeVolume) }
				is Marker.Spoken -> speakMarker(marker.text)
			}
			if (started != null) {
				markerInFlight = started
				return true
			}
		}
		markerInFlight = null
		return false
	}

	private fun speakMarker(text: String): Long? {
		val client = playback.sttsClient() ?: return null
		val provider = playback.currentProvider() ?: return null
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		return playback.stts.playMarker(client, provider, voice, text, playback.sttsVolume)
	}

	@Volatile
	var chimeSource: (() -> File?)? = null

	private suspend fun onPlaybackEnded(
		team: String,
		outcome: SttsPlayer.Outcome,
		gen: Long,
		reason: String?,
	) {
		try {
			advanceEnded(team, outcome, gen, reason)
		} finally {
			transportChanged()
		}
	}

	private suspend fun advanceEnded(team: String, outcome: SttsPlayer.Outcome, gen: Long, reason: String?) {
		advanceMutex.withLock {
			if (team == SttsPlayer.MARKER_TEAM) {
				// Ignore stale marker terminals.
				if (gen != markerInFlight) return
				markerInFlight = null
				val owner = queue.ticket()
				if (owner == null || markersFor != owner) {
					clearMarkers()
					resumeIfSilent()
					return
				}
				// Capture owner so the gap callback can reject stale work.
				playback.stts.afterGap {
					repoScope.launch(Dispatchers.IO) {
						advanceMutex.withLock {
							if (markersFor != owner || queue.ticket() != owner) return@withLock
							if (nextMarkerStarted()) return@withLock
							clearMarkers()
							startHead(owner, markersAnnounced = true)
						}
					}
				}
				return@withLock
			}
			if (team == SttsPlayer.SAMPLE_TEAM) {
				resumeIfSilent()
				return@withLock
			}
			val step = queue.ended(gen, outcome, reason)
			step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
			if (step.next != null) {
				startHead(step.next)
				return
			}
			if (step.standDown) {
				if (!playback.stts.isSounding()) resumeIfSilent()
				return
			}
			resumeIfSilent()
		}
	}

	suspend fun dropQueuedFor(team: String) {
		advanceMutex.withLock {
			// Drop before stopping, so its terminal is stale.
			queue.dropTeam(team)
			if (parkedAnnounced?.team == team) parkedAnnounced = null
			playback.stts.forgetTeamPositions(team)
			if (markersFor?.entry?.team == team) {
				markerInFlight?.let { playback.stts.abandonGeneration(it) }
				clearMarkers()
			}
			resumeIfSilent()
		}
		transportChanged()
	}

	override suspend fun clearInMemory() {
		advanceMutex.withLock {
			markerInFlight?.let { playback.stts.abandonGeneration(it) }
			queue.clear()
			clearMarkers()
			parkedAnnounced = null
			nextRunChime = false
			pausedFlag = false
		}
		transportChanged()
	}

	@Volatile
	private var pausedFlag = false
	private var transportPaused: Boolean
		get() {
			if (pausedFlag && queue.isIdle()) pausedFlag = false
			return pausedFlag
		}
		set(value) {
			pausedFlag = value
		}

	@Volatile
	var onTransportChanged: (() -> Unit)? = null

	val queueRevision: kotlinx.coroutines.flow.StateFlow<Int> get() = _queueRevision
	private val _queueRevision = kotlinx.coroutines.flow.MutableStateFlow(0)

	private fun transportChanged() {
		_queueRevision.value = _queueRevision.value + 1
		warmQueued()
		runIsolated { onTransportChanged?.invoke() }
	}

	private fun warmQueued() {
		val client = playback.sttsClient() ?: return
		val provider = playback.currentProvider() ?: return
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		val state = state.value
		for (entry in queue.queued()) {
			val tier = entry.tier ?: continue
			val msg = state.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe } ?: continue
			val text = ttsTextFramed(state, msg, tier, attributed = false)
			if (text.isNotBlank()) playback.stts.cache.warm(client, provider, voice, entry.team, entry.at, tier, text, "${msg.epoch}-${msg.seq}")
		}
	}

	private fun resumeIfSilent() {
		if (transportPaused || queue.playing() != null || playback.stts.isSounding()) return
		queue.startNext()?.let { startHead(it) }
	}

	suspend fun pausePlayback() {
		advanceMutex.withLock {
			// An idle queue has no terminal to clear a pause flag.
			if (queue.isIdle()) return@withLock
			transportPaused = true
			markerInFlight?.let { playback.stts.abandonGeneration(it) }
			clearMarkers()
			val head = queue.ticket()
			if (head != null) {
				parkedAnnounced = head.entry
				queue.park(head)
			}
		}
		transportChanged()
	}

	suspend fun resumePlayback() {
		advanceMutex.withLock {
			transportPaused = false
			resumeIfSilent()
		}
		transportChanged()
	}

	suspend fun skipPlayback() {
		try {
			advanceMutex.withLock {
				// Promote a parked head so skip discards it instead of resuming it.
				val head = queue.ticket() ?: queue.startNext() ?: return@withLock
				retireHead(head)
			}
		} finally {
			transportChanged()
		}
	}

	fun transportState(): Pair<Boolean, Boolean> = reads.transportState()

	fun queueRows(): List<QueueRow> = reads.queueRows()

	fun failedRows(): List<QueueRow> = reads.failedRows()

	suspend fun dropFromQueue(entry: QueueEntry) {
		try {
			advanceMutex.withLock {
				val head = queue.ticket()
				if (head?.entry == entry) {
					retireHead(head)
					return@withLock
				}
				queue.drop(entry)
				if (parkedAnnounced == entry) parkedAnnounced = null
				playback.stts.forgetPosition(entry.team, entry.at, entry.tier)
				resumeIfSilent()
			}
		} finally {
			transportChanged()
		}
	}

	/** Drops queued rows; stops playback. */
	suspend fun dropRows(team: String, ats: Set<Long>) {
		val cut = advanceMutex.withLock { queue.queued().filter { it.team == team && it.at in ats } }
		for (entry in cut) dropFromQueue(entry)
		for (at in ats) if (isMessagePlaying(team, at)) stopMessage(team, at)
	}

	// Skips advance as stopped, never completed.
	private fun retireHead(head: HeadTicket) {
		val entry = head.entry
		if (parkedAnnounced == entry) parkedAnnounced = null
		markerInFlight?.let { playback.stts.abandonGeneration(it) }
		clearMarkers()
		playback.stts.forgetPosition(entry.team, entry.at, entry.tier)
		val next = queue.advance(head, SttsPlayer.Outcome.STOPPED).next
		if (next == null) return
		if (transportPaused) {
			parkedAnnounced = null
			queue.park(next)
		} else {
			startHead(next)
		}
	}

	suspend fun acknowledgeFailure(entry: QueueEntry) {
		advanceMutex.withLock { queue.forgetFailure(entry) }
		transportChanged()
	}

	fun playbackPosition(): Position? = reads.playbackPosition()

	fun heldPosition(): Long? = reads.heldPosition()

	fun seekPlayback(ms: Long) {
		val snap = playbackPosition() ?: return
		playback.stts.seekTo(snap.owner, ms)
	}

	fun jumpTo(entry: QueueEntry): String? = collaborators.openThread(entry.team)

	fun queueCounts(): Triple<Int, Boolean, Int> = reads.queueCounts()

	/** Re-decide the head's tier. */
	private fun decidedHead(ticket: HeadTicket): HeadTicket {
		val entry = ticket.entry
		val tier = entry.tier ?: return ticket
		val decided = entry.copy(tier = lockedTier(entry.team, tier))
		if (decided == entry) return ticket
		val rewritten = queue.rewriteHead(ticket, decided) ?: return ticket
		if (markersFor == ticket) markersFor = rewritten
		if (parkedAnnounced == entry) parkedAnnounced = decided
		return rewritten
	}

	/** Locking converts assistant speech to locked form. */
	suspend fun relock() {
		advanceMutex.withLock {
			val head = queue.ticket() ?: return@withLock
			// In the gap after its last marker, it was announced. A marker whose terminal is not yet
			// handled has still ended.
			val markerDone = markerInFlight?.let { !playback.stts.isGenerationLive(it) } ?: true
			val markersAnnounced = markersFor != head || (pendingMarkers.isEmpty() && markerDone)
			val decided = decidedHead(head)
			if (decided == head) return@withLock
			markerInFlight?.let { playback.stts.abandonGeneration(it) }
			clearMarkers()
			startHead(decided, markersAnnounced)
		}
		transportChanged()
	}

	/** Whether a lock would change what is said. */
	fun speaksUnlockedAssistant(): Boolean {
		val state = state.value
		return listOfNotNull(queue.playing()).any {
			it.tier != null && it.tier != SttsPlayer.Tier.LOCKED && isAssistant(state, it.team)
		}
	}

	private fun startHead(initial: HeadTicket, markersAnnounced: Boolean = false) {
		var ticket = initial
		var hasAnnounced = markersAnnounced
		while (true) {
			ticket = decidedHead(ticket)
			val entry = ticket.entry
			val msg = state.value.threads[entry.team]?.lastOrNull { it.at == entry.at && !it.fromMe }
			if (msg == null) {
				if (parkedAnnounced == entry) parkedAnnounced = null
				val step = queue.advance(ticket, SttsPlayer.Outcome.SYNTH_ERROR, "message is no longer here")
				step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
				ticket = step.next ?: return
				hasAnnounced = false
				continue
			}
			// Quietness may change while queued.
			if (msg.isQuiet()) {
				if (parkedAnnounced == entry) parkedAnnounced = null
				clearMarkers()
				val step = queue.advance(ticket, SttsPlayer.Outcome.STOPPED)
				ticket = step.next ?: return
				hasAnnounced = false
				continue
			}
			val tier = entry.tier
			if (tier == null) {
				if (parkedAnnounced == entry) parkedAnnounced = null
				val step = queue.advance(ticket, SttsPlayer.Outcome.SYNTH_ERROR, "no tier to speak")
				step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
				ticket = step.next ?: return
				hasAnnounced = false
				continue
			}
			val client = playback.sttsClient()
			val provider = playback.currentProvider()
			val reason = when {
				client == null -> "no voice key set"
				provider == null -> "no voice provider set"
				else -> null
			}
			if (reason != null) {
				if (parkedAnnounced == entry) parkedAnnounced = null
				val step = queue.advance(ticket, SttsPlayer.Outcome.SYNTH_ERROR, reason)
				step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
				ticket = step.next ?: return
				hasAnnounced = false
				continue
			}
			val readyClient = requireNotNull(client)
			val readyProvider = requireNotNull(provider)
			val text = ttsTextFramed(state.value, msg, tier, attributed = false)
			if (text.isBlank()) {
				if (parkedAnnounced == entry) parkedAnnounced = null
				val step = queue.advance(ticket, SttsPlayer.Outcome.SYNTH_ERROR, "nothing to read aloud")
				step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
				ticket = step.next ?: return
				hasAnnounced = false
				continue
			}
			if (parkedAnnounced == entry) {
				parkedAnnounced = null
				hasAnnounced = true
			}
			if (!hasAnnounced) {
				if (markersFor != ticket) {
					queueMarkers(ticket, chime = nextRunChime)
					nextRunChime = false
				}
				if (nextMarkerStarted()) return
				clearMarkers()
				hasAnnounced = true
			}
			val voice = playback.sttsVoiceFor(readyProvider.id).takeIf { it.isNotEmpty() }
			val admission = queue.admit(ticket) {
				playback.stts.claim(entry.team, entry.at, tier)
			}
			when (admission) {
				HeadAdmission.Stale -> return
				HeadAdmission.Busy -> {
					val step = queue.advance(ticket, SttsPlayer.Outcome.SYNTH_ERROR, "already speaking")
					step.failed?.let { DebugLog.log("Stts", "giving up on ${it.team} @${it.at} after a retry") }
					ticket = step.next ?: return
					hasAnnounced = false
				}
				is HeadAdmission.Admitted -> {
					playback.stts.playClaimed(
						admission.id,
						readyClient,
						readyProvider,
						voice,
						text,
						playback.sttsVolume,
						"${msg.epoch}-${msg.seq}",
					)
					return
				}
			}
		}
	}

	internal fun autoPlayTier(value: String): SttsPlayer.Tier? = when (value) {
		"title" -> SttsPlayer.Tier.TITLE
		"summary" -> SttsPlayer.Tier.SUMMARY
		"full" -> SttsPlayer.Tier.FULL
		else -> null
	}

	internal fun preloadMessage(team: String, at: Long) {
		val client = playback.sttsClient() ?: return
		val provider = playback.currentProvider() ?: return
		val msg = state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return
		val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		playback.stts.cache.preloadTiers(
			client,
			provider,
			voice,
			team,
			at,
			ttsTextFramed(state.value, msg, SttsPlayer.Tier.TITLE),
			ttsTextFramed(state.value, msg, SttsPlayer.Tier.SUMMARY),
			ttsTextFramed(state.value, msg, SttsPlayer.Tier.FULL),
			rowKey = "${msg.epoch}-${msg.seq}",
		)
	}

	fun playSttsSample() {
		playback.stts.post {
			val client = playback.sttsClient() ?: return@post
			val provider = playback.currentProvider() ?: return@post
			val voice = playback.sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			playback.stts.playSample(client, provider, voice, "This is your switchboard voice.", playback.sttsVolume)
		}
	}
}
