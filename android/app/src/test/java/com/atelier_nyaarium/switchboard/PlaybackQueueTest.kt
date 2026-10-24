package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Failures preserve unheard messages. */
class PlaybackQueueTest {
	private val team = "local.gw.evie-bot.main"
	private val other = "local.gw.other.main"

	private fun entry(at: Long, team: String = this.team, tier: SttsPlayer.Tier? = SttsPlayer.Tier.FULL) =
		QueueEntry(team, at, tier)

	private data class Ending(val id: PlaybackId, val remember: Boolean, val ticket: HeadTicket?)

	private inner class Harness(vararg entries: QueueEntry) {
		val requests = PlaybackRequests()
		val endings = mutableListOf<Ending>()
		lateinit var queue: PlaybackQueue

		init {
			queue = PlaybackQueue { id, remember ->
				endings += Ending(id, remember, queue.ticket())
				requests.finishRequest(id, SttsPlayer.Outcome.PREEMPTED)
			}
			entries.forEach { queue.enqueue(it) }
		}

		fun claim(ticket: HeadTicket): PlaybackId? =
			(queue.admit(ticket) {
				requests.claim(ticket.entry.team, ticket.entry.at, ticket.entry.tier)
			} as? HeadAdmission.Admitted)?.id
	}

	private fun fixture(vararg entries: QueueEntry) = Harness(*entries)

	@Test
	fun `a burst speaks every message in the order it arrived`() {
		val q = fixture(entry(1), entry(2), entry(3)).queue
		val spoken = mutableListOf<QueueEntry>()
		var current = q.startNext()
		while (current != null) {
			spoken += current.entry
			current = q.advance(current, SttsPlayer.Outcome.COMPLETED).next
		}
		assertEquals(listOf(entry(1), entry(2), entry(3)), spoken)
	}

	@Test
	fun `a paused entry comes back before everything waiting`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!

		assertTrue(q.park(head))

		assertEquals(entry(1), q.startNext()?.entry)
		assertEquals(listOf(entry(1), entry(2)), q.queued())
	}

	@Test
	fun `requeueing something already waiting changes nothing`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!

		// Repeated parks keep one queued entry.
		assertTrue(q.park(head))
		assertFalse(q.park(head))
		assertEquals(listOf(entry(1), entry(2)), q.queued())
	}

	@Test
	fun `skipping after a pause discards the paused entry rather than replaying it`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!
		q.park(head)

		// Skip promotes parked work before discarding it.
		val promoted = q.startNext()!!
		assertEquals(entry(1), promoted.entry)
		assertEquals(entry(2), q.advance(promoted, SttsPlayer.Outcome.STOPPED).next?.entry)
		assertEquals(listOf(entry(2)), q.queued())
	}

	@Test
	fun `a run is idle only before it starts and after it drains`() {
		val q = fixture(entry(1), entry(2)).queue
		assertFalse(q.isIdle())

		val first = q.startNext()!!
		val second = q.advance(first, SttsPlayer.Outcome.COMPLETED).next!!
		assertFalse(q.isIdle())

		q.advance(second, SttsPlayer.Outcome.COMPLETED)
		assertTrue(q.isIdle())
	}

	@Test
	fun `a run that stood down is not idle`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!

		val step = q.advance(head, SttsPlayer.Outcome.PREEMPTED)

		// Backlog keeps a stood-down run active.
		assertNull(step.next)
		assertTrue(step.standDown)
		assertNull(q.playing())
		assertFalse(q.isIdle())
		assertEquals(listOf(entry(1), entry(2)), q.queued())
	}

	@Test
	fun `the same message is not queued twice`() {
		val q = fixture(entry(1), entry(2)).queue
		assertFalse(q.enqueue(entry(1)))
		val head = q.startNext()!!
		// Redelivery cannot queue a playing entry twice.
		assertFalse(q.enqueue(entry(1)))
		assertFalse(q.enqueue(entry(2)))
		assertEquals(listOf(head.entry, entry(2)), q.queued())
	}

	@Test
	fun `stopping one message retires it and carries on`() {
		val q = fixture(entry(1), entry(2)).queue
		val step = q.advance(q.startNext()!!, SttsPlayer.Outcome.STOPPED)
		assertEquals(entry(2), step.next?.entry)
	}

	@Test
	fun `only a stand-down forbids the caller from starting something`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!
		val stale = fixture(entry(99)).queue.startNext()!!

		assertTrue(q.advance(stale, SttsPlayer.Outcome.COMPLETED).standDown)
		assertEquals(entry(1), q.playing())
		val step = q.advance(head, SttsPlayer.Outcome.COMPLETED)
		assertFalse(step.standDown)
		assertEquals(entry(2), step.next?.entry)
	}

	@Test
	fun `the run picks up again once the sound is free`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!
		q.advance(head, SttsPlayer.Outcome.PREEMPTED)
		assertEquals(entry(1), q.startNext()?.entry)
	}

	@Test
	fun engineCompletionAdvancesTheClaimedHead() {
		val fixture = fixture(entry(1), entry(2))
		val ticket = fixture.queue.startNext()!!
		val id = fixture.claim(ticket)!!
		fixture.requests.finishRequest(id, SttsPlayer.Outcome.COMPLETED)

		val step = fixture.queue.ended(id.gen, SttsPlayer.Outcome.COMPLETED)

		assertFalse(step.standDown)
		assertEquals(entry(2), step.next?.entry)
	}

	@Test
	fun `being displaced retires the head but starts nothing`() {
		val fixture = fixture(entry(1), entry(2))
		val ticket = fixture.queue.startNext()!!
		val id = fixture.claim(ticket)!!
		fixture.requests.finishRequest(id, SttsPlayer.Outcome.PREEMPTED)

		val step = fixture.queue.ended(id.gen, SttsPlayer.Outcome.PREEMPTED)

		assertTrue(step.standDown)
		assertNull(fixture.queue.ticket())
		assertEquals(listOf(entry(1), entry(2)), fixture.queue.queued())
		assertEquals(entry(1), fixture.queue.startNext()?.entry)
	}

	@Test
	fun `a failure goes to the tail once, then is dropped and remembered`() {
		val q = fixture(entry(1), entry(2)).queue
		val first = q.startNext()!!

		val retry = q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR, "no key")
		assertEquals(entry(2), retry.next?.entry)
		assertNull(retry.failed)
		val retryTarget = q.advance(retry.next!!, SttsPlayer.Outcome.COMPLETED).next!!

		val failed = q.advance(retryTarget, SttsPlayer.Outcome.SYNTH_ERROR, "no key")
		assertNull(failed.next)
		assertEquals(entry(1), failed.failed)
		assertEquals(listOf(entry(1)), q.remembered())
		assertEquals("no key", q.reasonFor(entry(1)))
	}

	@Test
	fun `a failure remembers why, and the same message never doubles up`() {
		val q = fixture(entry(1), entry(2)).queue
		q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR, "first reason")
		q.advance(q.ticket()!!, SttsPlayer.Outcome.COMPLETED)
		q.advance(q.ticket()!!, SttsPlayer.Outcome.SYNTH_ERROR, "first reason")
		q.enqueue(entry(1))
		q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR, "first reason")
		q.advance(q.ticket()!!, SttsPlayer.Outcome.SYNTH_ERROR, "second reason")

		assertEquals(listOf(entry(1)), q.remembered())
		assertEquals("second reason", q.reasonFor(entry(1)))
	}

	@Test
	fun `an outcome for an entry that is no longer the head changes nothing`() {
		val q = fixture(entry(1), entry(2)).queue
		val old = q.startNext()!!
		val current = q.advance(old, SttsPlayer.Outcome.COMPLETED).next!!

		val late = q.advance(old, SttsPlayer.Outcome.COMPLETED)

		assertNull(late.next)
		assertTrue(late.standDown)
		assertEquals(current.entry, q.playing())
	}

	@Test
	fun `two advances for one head cannot both move the queue`() {
		val q = fixture(entry(1), entry(2), entry(3)).queue
		val head = q.startNext()!!

		val first = q.advance(head, SttsPlayer.Outcome.COMPLETED)
		val second = q.advance(head, SttsPlayer.Outcome.COMPLETED)

		assertEquals(entry(2), first.next?.entry)
		assertNull(second.next)
		assertTrue(second.standDown)
		assertEquals(entry(2), q.playing())
	}

	@Test
	fun `dropping a team takes its queued, playing and remembered entries`() {
		val q = fixture(entry(1)).queue
		val head = q.startNext()!!
		q.advance(head, SttsPlayer.Outcome.PLAYBACK_ERROR)
		q.advance(q.ticket()!!, SttsPlayer.Outcome.PLAYBACK_ERROR)
		q.enqueue(entry(2))
		q.enqueue(entry(3, other))
		q.enqueue(entry(4))
		q.startNext()

		assertEquals(entry(2), q.dropTeam(team))
		assertTrue(q.remembered().isEmpty())
		assertEquals(listOf(entry(3, other)), q.queued())
	}

	@Test
	fun `dropping a team leaves another team playing`() {
		val q = fixture(entry(1, other), entry(2)).queue
		val head = q.startNext()!!

		assertNull(q.dropTeam(team))
		assertEquals(head.entry, q.playing())
		assertEquals(listOf(entry(1, other)), q.queued())
	}

	@Test
	fun `dropping a waiting entry removes it and leaves the rest speaking in order`() {
		val q = fixture(entry(1), entry(2), entry(3)).queue
		val head = q.startNext()!!

		assertTrue(q.drop(entry(2)))
		assertEquals(head.entry, q.playing())
		assertEquals(listOf(entry(1), entry(3)), q.queued())
	}

	@Test
	fun `dropping the head is refused, so nothing removes an entry the engine is already playing`() {
		val q = fixture(entry(1), entry(2)).queue
		val head = q.startNext()!!

		assertFalse(q.drop(head.entry))
		assertEquals(head.entry, q.playing())
	}

	@Test
	fun `a dropped entry that comes back counts as a first failure again`() {
		// Two entries keep the retry waiting.
		val q = fixture(entry(1), entry(2)).queue
		val first = q.startNext()!!
		q.advance(first, SttsPlayer.Outcome.SYNTH_ERROR)
		assertTrue(q.drop(entry(1)))
		q.enqueue(entry(1))
		q.advance(q.ticket()!!, SttsPlayer.Outcome.COMPLETED)

		assertNull(q.advance(q.ticket()!!, SttsPlayer.Outcome.SYNTH_ERROR).failed)
	}

	@Test
	fun `speaking a remembered failure clears it from the alert`() {
		val q = fixture(entry(1), entry(2)).queue
		q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR)
		q.advance(q.ticket()!!, SttsPlayer.Outcome.COMPLETED)
		q.advance(q.ticket()!!, SttsPlayer.Outcome.SYNTH_ERROR)
		assertEquals(listOf(entry(1)), q.remembered())

		q.enqueue(entry(1))
		q.advance(q.startNext()!!, SttsPlayer.Outcome.COMPLETED)

		assertTrue(q.remembered().isEmpty())
	}

	@Test
	fun `skipping a remembered failure does not count as having heard it`() {
		val q = fixture(entry(1), entry(2)).queue
		q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR)
		q.advance(q.ticket()!!, SttsPlayer.Outcome.COMPLETED)
		q.advance(q.ticket()!!, SttsPlayer.Outcome.SYNTH_ERROR)
		q.enqueue(entry(1))

		q.advance(q.startNext()!!, SttsPlayer.Outcome.STOPPED)

		assertEquals(listOf(entry(1)), q.remembered())
	}

	@Test
	fun `a dropped team's failure can no longer be retried into the queue`() {
		val q = fixture(entry(1)).queue
		q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR)
		q.dropTeam(team)
		q.enqueue(entry(1))

		assertNull(q.advance(q.startNext()!!, SttsPlayer.Outcome.SYNTH_ERROR).failed)
	}

	@Test
	fun eachHeadAssignmentMintsATicketIncludingParkAndResume() {
		val q = fixture(entry(1)).queue
		val first = q.startNext()!!
		q.park(first)
		val resumed = q.startNext()!!

		assertEquals(first.entry, resumed.entry)
		assertTrue(resumed.serial > first.serial)
		assertTrue(q.rewriteHead(resumed, entry(1, tier = SttsPlayer.Tier.LOCKED))!!.serial > resumed.serial)
	}

	@Test
	fun staleAdmissionIsRejectedAfterEveryHeadTransition() {
		val transitions: List<(PlaybackQueue, HeadTicket) -> Unit> = listOf(
			{ q, ticket -> q.rewriteHead(ticket, ticket.entry.copy(tier = SttsPlayer.Tier.LOCKED)) },
			{ q, ticket -> q.park(ticket) },
			{ q, ticket -> q.advance(ticket, SttsPlayer.Outcome.COMPLETED) },
			{ q, ticket -> q.advance(ticket, SttsPlayer.Outcome.STOPPED) },
			{ q, ticket -> q.advance(ticket, SttsPlayer.Outcome.PREEMPTED) },
			{ q, ticket -> q.advance(ticket, SttsPlayer.Outcome.PLAYBACK_ERROR) },
			{ q, ticket -> q.advance(ticket, SttsPlayer.Outcome.SYNTH_ERROR) },
			{ q, _ -> q.dropTeam(team) },
			{ q, _ -> q.clear() },
		)

		for (transition in transitions) {
			val fixture = fixture(entry(1), entry(2))
			val stale = fixture.queue.startNext()!!
			transition(fixture.queue, stale)
			var claimed = false

			val answer = fixture.queue.admit(stale) {
				claimed = true
				fixture.requests.claim(team, 99L, SttsPlayer.Tier.FULL)
			}

			assertEquals(HeadAdmission.Stale, answer)
			assertFalse(claimed)
		}
	}

	@Test
	fun oneTicketCannotClaimTwice() {
		val fixture = fixture(entry(1))
		val ticket = fixture.queue.startNext()!!
		val first = fixture.claim(ticket)
		var claimedAgain = false

		val second = fixture.queue.admit(ticket) {
			claimedAgain = true
			fixture.requests.claim(team, 1L, SttsPlayer.Tier.FULL)
		}

		assertTrue(first != null)
		assertEquals(HeadAdmission.Stale, second)
		assertFalse(claimedAgain)
	}

	@Test
	fun engineRefusalDoesNotHoldTheTicketClaim() {
		val fixture = fixture(entry(1))
		val ticket = fixture.queue.startNext()!!

		assertEquals(HeadAdmission.Busy, fixture.queue.admit(ticket) { null })
		assertTrue(fixture.claim(ticket) != null)
	}

	@Test
	fun ticketTransitionsEndClaimsBeforeCreatingTheNextTicket() {
		val transitions: List<(Harness, HeadTicket) -> Boolean> = listOf(
			{ f, t -> f.queue.rewriteHead(t, t.entry.copy(tier = SttsPlayer.Tier.LOCKED)) != null },
			{ f, t -> f.queue.park(t) },
			{ f, t -> f.queue.advance(t, SttsPlayer.Outcome.COMPLETED).next != null },
			{ f, t -> f.queue.advance(t, SttsPlayer.Outcome.STOPPED).next != null },
			{ f, t -> f.queue.advance(t, SttsPlayer.Outcome.PREEMPTED).standDown },
			{ f, t -> f.queue.advance(t, SttsPlayer.Outcome.PLAYBACK_ERROR).next != null },
			{ f, t -> f.queue.advance(t, SttsPlayer.Outcome.SYNTH_ERROR).next != null },
			{ f, _ -> f.queue.dropTeam(team) != null },
			{ f, _ -> f.queue.clear(); true },
		)

		for ((index, transition) in transitions.withIndex()) {
			val f = fixture(entry(1), entry(2))
			val old = f.queue.startNext()!!
			val id = f.claim(old)!!

			transition(f, old)

			assertEquals(1, f.endings.size)
			assertEquals(id, f.endings.single().id)
			assertEquals(index == 1, f.endings.single().remember)
			assertEquals(old, f.endings.single().ticket)
		}
	}

	@Test
	fun endedIgnoresTheOldGenerationAfterTheSameEntryGetsANewTicket() {
		val f = fixture(entry(1))
		val oldTicket = f.queue.startNext()!!
		val oldId = f.claim(oldTicket)!!
		f.queue.park(oldTicket)
		val newTicket = f.queue.startNext()!!
		val newId = f.claim(newTicket)!!

		val stale = f.queue.ended(oldId.gen, SttsPlayer.Outcome.COMPLETED)

		assertTrue(stale.standDown)
		assertEquals(newTicket, f.queue.ticket())
		assertTrue(f.requests.isLive(newId))
	}
}
