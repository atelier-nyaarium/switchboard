package com.atelier_nyaarium.switchboard

/** One thing to speak, in the tier chosen when it was enqueued. */
data class QueueEntry(val team: String, val at: Long, val tier: SttsPlayer.Tier?)

/** Fresh per head assignment; a stale holder cannot claim. */
data class HeadTicket(val entry: QueueEntry, val serial: Long)

/** Body admission result. */
sealed interface HeadAdmission {
	data class Admitted(val id: PlaybackId) : HeadAdmission
	data object Stale : HeadAdmission
	data object Busy : HeadAdmission
}

/**
 * [standDown] tells callers not to restart over displaced audio or act on stale outcomes.
 */
data class QueueStep(val next: HeadTicket?, val failed: QueueEntry? = null, val standDown: Boolean = false)

/**
 * The autoplay queue with no player in it. Transitions are synchronized because completions and
 * user actions can race on one head, so the same head cannot advance twice. [setHead] is the only writer.
 * It ends the held claim through [end] before minting a replacement ticket, so no claim outlives the
 * head it was admitted for.
 */
class PlaybackQueue(private val end: (PlaybackId, Boolean) -> Unit) {
	private val pending = ArrayDeque<QueueEntry>()
	private var current: HeadTicket? = null
	private var claim: PlaybackId? = null
	private var serial = 0L

	// One retry prevents loops.
	private val retried = mutableSetOf<QueueEntry>()

	// One alert per entry; teardown clears failures with their team.
	// Bounded oldest-first; outages fail whole bursts.
	private val failures = LinkedHashMap<QueueEntry, String?>()

	@Synchronized
	fun queued(): List<QueueEntry> = listOfNotNull(current?.entry) + pending

	@Synchronized
	fun playing(): QueueEntry? = current?.entry

	@Synchronized
	fun ticket(): HeadTicket? = current

	/** Chime once per run. */
	@Synchronized
	fun isIdle(): Boolean = current == null && pending.isEmpty()

	@Synchronized
	fun remembered(): List<QueueEntry> = failures.keys.toList()

	/** Failure reasons distinguish alerts. */
	@Synchronized
	fun reasonFor(entry: QueueEntry): String? = failures[entry]

	@Synchronized
	fun enqueue(entry: QueueEntry): Boolean {
		if (current?.entry == entry || pending.contains(entry)) return false
		pending.addLast(entry)
		return true
	}

	@Synchronized
	fun startNext(): HeadTicket? {
		if (current != null) return null
		return setHead(pending.removeFirstOrNull(), remember = false)
	}

	@Synchronized
	fun admit(ticket: HeadTicket, claim: () -> PlaybackId?): HeadAdmission {
		if (current != ticket || this.claim != null) return HeadAdmission.Stale
		val id = claim() ?: return HeadAdmission.Busy
		this.claim = id
		return HeadAdmission.Admitted(id)
	}

	@Synchronized
	fun advance(ticket: HeadTicket, outcome: SttsPlayer.Outcome, reason: String? = null): QueueStep {
		// Stale outcomes cannot advance a replacement head.
		if (current != ticket) return QueueStep(null, standDown = true)
		return advanceCurrent(ticket, outcome, reason)
	}

	@Synchronized
	fun ended(gen: Long, outcome: SttsPlayer.Outcome, reason: String? = null): QueueStep {
		// Reject terminals from replaced claims.
		if (claim?.gen != gen) return QueueStep(null, standDown = true)
		val ticket = current ?: return QueueStep(null, standDown = true)
		claim = null
		return advanceCurrent(ticket, outcome, reason)
	}

	@Synchronized
	fun rewriteHead(ticket: HeadTicket, to: QueueEntry): HeadTicket? {
		if (current != ticket) return null
		if (ticket.entry == to) return ticket
		if (retried.remove(ticket.entry)) retried.add(to)
		return setHead(to, remember = false)
	}

	/** Requeue first; ending retires the head but preserves its position. */
	@Synchronized
	fun park(ticket: HeadTicket): Boolean {
		if (current != ticket) return false
		if (!pending.contains(ticket.entry)) pending.addFirst(ticket.entry)
		setHead(null, remember = true)
		return true
	}

	@Synchronized
	fun dropTeam(team: String): QueueEntry? {
		pending.removeAll { it.team == team }
		retried.removeAll { it.team == team }
		failures.keys.removeAll { it.team == team }
		val dropped = current?.entry?.takeIf { it.team == team }
		if (dropped != null) setHead(null, remember = false)
		return dropped
	}

	/** Waiting entries only; giving up the head is a skip. */
	@Synchronized
	fun drop(entry: QueueEntry): Boolean {
		if (current?.entry == entry) return false
		// Dropping resets its retry count.
		retried.remove(entry)
		return pending.remove(entry)
	}

	@Synchronized
	fun forgetFailure(entry: QueueEntry): Boolean = failures.remove(entry) != null

	@Synchronized
	fun clear() {
		pending.clear()
		retried.clear()
		failures.clear()
		setHead(null, remember = false)
	}

	private fun advanceCurrent(ticket: HeadTicket, outcome: SttsPlayer.Outcome, reason: String?): QueueStep {
		val entry = ticket.entry
		return when (outcome) {
			SttsPlayer.Outcome.COMPLETED, SttsPlayer.Outcome.STOPPED -> {
				// Stop skips; pause parks; only completion marks heard.
				if (outcome == SttsPlayer.Outcome.COMPLETED) failures.remove(entry)
				QueueStep(setHead(pending.removeFirstOrNull(), remember = false))
			}

			// Keep yielded work; do not restart over its replacement.
			SttsPlayer.Outcome.PREEMPTED -> {
				if (!pending.contains(entry)) pending.addFirst(entry)
				setHead(null, remember = false)
				QueueStep(null, standDown = true)
			}

			SttsPlayer.Outcome.PLAYBACK_ERROR, SttsPlayer.Outcome.SYNTH_ERROR -> {
				if (retried.add(entry)) {
					pending.addLast(entry)
					QueueStep(setHead(pending.removeFirstOrNull(), remember = false))
				} else {
					retried.remove(entry)
					failures[entry] = reason
					while (failures.size > MAX_REMEMBERED_FAILURES) {
						failures.remove(failures.keys.first())
					}
					QueueStep(setHead(pending.removeFirstOrNull(), remember = false), failed = entry)
				}
			}
		}
	}

	private fun setHead(next: QueueEntry?, remember: Boolean): HeadTicket? {
		claim?.let {
			claim = null
			// Prevent old claims reaching replacement tickets.
			end(it, remember)
		}
		val ticket = next?.let { HeadTicket(it, serial++) }
		current = ticket
		return ticket
	}

	private companion object {
		const val MAX_REMEMBERED_FAILURES = 50
	}
}
