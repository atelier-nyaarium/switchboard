package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.OwnerPrompt
import com.atelier_nyaarium.switchboard.passes
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalGateTest {
	private var policy = VAULT_UNLOCK_OFF
	private var elapsed = 5_000L
	private var prompts = 0
	private var answer = OwnerPrompt.PASSED
	private var lockOn = true
	private var unlocked = true
	private var lockEpoch = 0
	private var promptTitle = ""
	private var promptSubtitle = ""

	private fun gate() = ApprovalGate(
		policy = { policy },
		persist = { policy = it },
		authenticate = { _, title, subtitle -> prompts++; promptTitle = title; promptSubtitle = subtitle; answer },
		lockOn = { lockOn },
		unlocked = { unlocked },
		lockEpoch = { lockEpoch },
		elapsed = { elapsed },
	)

	/** A passed prompt, matched to `nyaarium` at revision 3. */
	private suspend fun matched(gate: ApprovalGate, request: String = "req", entry: String = "nyaarium", revision: Long = 3L) {
		(gate.require(null) as? Presence.Asked)?.let { gate.grantMatch(it.receipt, request, entry, revision) }
	}

	@Test
	fun offOwesNothingEveryPromptsAndAWindowPromptsOncePerThirtyMinutes() = runBlocking {
		val gate = gate()
		assertEquals(Presence.NotOwed, gate.require(null))
		assertEquals(0, prompts)

		policy = VAULT_UNLOCK_EVERY
		assertTrue(gate.require(null) is Presence.Asked)
		assertTrue(gate.require(null) is Presence.Asked)
		assertEquals(2, prompts)

		elapsed += VAULT_UNLOCK_WINDOW_MS + 1
		policy = VAULT_UNLOCK_WINDOW
		assertTrue(gate.require(null) is Presence.Asked)
		assertEquals(3, prompts)
		elapsed += VAULT_UNLOCK_WINDOW_MS - 1
		assertEquals(listOf(false, Presence.NotOwed), listOf(gate.owed(), gate.require(null)))
		assertEquals(3, prompts)
		elapsed += 2
		answer = OwnerPrompt.REFUSED
		assertEquals(listOf(true, Presence.Refused), listOf(gate.owed(), gate.require(null)))
		assertEquals(4, prompts)
	}

	@Test
	fun aPromptThePhoneCannotShowIsNoPresenceAndNoScreenLockOwesNothing() = runBlocking {
		policy = VAULT_UNLOCK_WINDOW
		val gate = gate()

		answer = OwnerPrompt.COULD_NOT_ASK
		assertEquals(Presence.CouldNotAsk, gate.require(null))
		answer = OwnerPrompt.NO_SCREEN_LOCK
		assertEquals(Presence.NotOwed, gate.require(null))

		// Neither opened the window.
		answer = OwnerPrompt.PASSED
		assertTrue(gate.require(null) is Presence.Asked)
		assertEquals(3, prompts)
	}

	@Test
	fun aCardLetsThroughExactlyWhatThePromptRuleLetsThrough() = runBlocking {
		policy = VAULT_UNLOCK_EVERY
		val gate = gate()

		for (asked in OwnerPrompt.entries) {
			answer = asked
			assertEquals(passes(asked), cardPresence(gate.require(null)) == CardPresence.Passed)
		}
	}

	@Test
	fun approvalUsesItsOwnPromptText() = runBlocking {
		policy = VAULT_UNLOCK_EVERY
		gate().require(null)
		assertEquals(VAULT_PRESENCE_TITLE, promptTitle)
		assertEquals(VAULT_PRESENCE_SUBTITLE, promptSubtitle)
	}

	@Test
	fun noAppLockOwesNothingWhateverThePolicyAndTheLockBringsItBack() = runBlocking {
		policy = VAULT_UNLOCK_EVERY
		lockOn = false
		val gate = gate()
		assertEquals(Presence.NotOwed, gate.require(null))
		assertEquals(0, prompts)

		lockOn = true
		answer = OwnerPrompt.REFUSED
		assertEquals(Presence.Refused, gate.require(null))
		assertEquals(1, prompts)
	}

	@Test
	fun tighteningIsFreeLooseningAsksAndAnyChangeEndsTheWindow() = runBlocking {
		val gate = gate()
		assertEquals(OwnerPrompt.PASSED, gate.changePolicy(VAULT_UNLOCK_WINDOW, null))
		assertEquals(OwnerPrompt.PASSED, gate.changePolicy(VAULT_UNLOCK_EVERY, null))
		assertEquals(0, prompts)
		assertEquals(VAULT_UNLOCK_EVERY, policy)

		for (refusing in listOf(OwnerPrompt.COULD_NOT_ASK, OwnerPrompt.REFUSED)) {
			answer = refusing
			assertEquals(refusing, gate.changePolicy(VAULT_UNLOCK_OFF, null))
			assertEquals(VAULT_UNLOCK_EVERY, policy)
		}
		answer = OwnerPrompt.PASSED
		assertEquals(OwnerPrompt.PASSED, gate.changePolicy(VAULT_UNLOCK_WINDOW, null))
		assertEquals(3, prompts)

		assertTrue(gate.require(null) is Presence.Asked)
		assertEquals(4, prompts)
		gate.changePolicy(VAULT_UNLOCK_OFF, null)
		gate.changePolicy(VAULT_UNLOCK_WINDOW, null)
		assertTrue(gate.require(null) is Presence.Asked)
		assertEquals(6, prompts)
	}

	@Test
	fun aPolicyChangeAndAnotherOwnerEndTheCarryAndTheWindow() = runBlocking {
		policy = VAULT_UNLOCK_EVERY
		val gate = gate()

		matched(gate)
		gate.changePolicy(VAULT_UNLOCK_WINDOW, null)
		policy = VAULT_UNLOCK_EVERY
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		matched(gate)
		gate.forget()
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		policy = VAULT_UNLOCK_WINDOW
		gate.require(null)
		assertEquals(Presence.NotOwed, gate.notOwed())
		gate.forget()
		assertEquals(listOf(null, true), listOf(gate.notOwed(), gate.owed()))
	}

	@Test
	fun aCarryIsJudgedByWhatHeldWhenThePromptWasAsked() = runBlocking {
		policy = VAULT_UNLOCK_EVERY
		var during: () -> Unit = {}
		val gate = ApprovalGate(
			policy = { policy },
			persist = { policy = it },
			authenticate = { _, _, _ -> during(); OwnerPrompt.PASSED },
			lockOn = { lockOn },
			unlocked = { unlocked },
			lockEpoch = { lockEpoch },
			elapsed = { elapsed },
		)

		// Relocked while the prompt was up.
		during = { lockEpoch++ }
		matched(gate)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		// Locked when asked, unlocked since.
		unlocked = false
		during = { unlocked = true }
		matched(gate)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		// Asked under a window, "Every approval" since.
		policy = VAULT_UNLOCK_WINDOW
		gate.forget()
		during = { policy = VAULT_UNLOCK_EVERY }
		matched(gate)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		// Its minute runs from the prompt.
		during = {}
		val asked = gate.require(null) as Presence.Asked
		elapsed += MATCH_PRESENCE_WINDOW_MS + 1
		gate.grantMatch(asked.receipt, "req", "nyaarium", 3L)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		matched(gate)
		assertTrue(gate.spendMatch("req", "nyaarium", 3L))
	}

	@Test
	fun aCardReadsAFaultAsItsOwnLineAndOnlyAPassAsPassed() {
		val asked = Presence.Asked(object : PresenceReceipt {})

		assertEquals(
			listOf(CardPresence.Passed, CardPresence.Passed, CardPresence.Declined),
			listOf(asked, Presence.NotOwed, Presence.Refused).map(::cardPresence),
		)
		assertTrue(cardPresence(Presence.CouldNotAsk) is CardPresence.Fault)
	}

	@Test
	fun aMatchCarriesToOneApprovalOfThatRequestEntryAndRevision() = runBlocking {
		policy = VAULT_UNLOCK_EVERY
		val gate = gate()

		matched(gate)
		assertEquals(listOf(true, false), List(2) { gate.spendMatch("req", "nyaarium", 3L) })

		val misses = listOf<suspend () -> Boolean>(
			{ gate.spendMatch("other", "nyaarium", 3L) },
			{ gate.spendMatch("req", "other", 3L) },
			{ gate.spendMatch("req", "nyaarium", 4L) },
			{ gate.spendMatch("req", "nyaarium", null) },
			{ elapsed += MATCH_PRESENCE_WINDOW_MS + 1; gate.spendMatch("req", "nyaarium", 3L) },
			{ lockEpoch++; gate.spendMatch("req", "nyaarium", 3L) },
			{ unlocked = false; gate.spendMatch("req", "nyaarium", 3L).also { unlocked = true } },
			{ gate.dropMatch(); gate.spendMatch("req", "nyaarium", 3L) },
			{ policy = VAULT_UNLOCK_WINDOW; gate.spendMatch("req", "nyaarium", 3L).also { policy = VAULT_UNLOCK_EVERY } },
		)
		for (miss in misses) {
			matched(gate)
			assertFalse(miss())
			// Any read spent it.
			assertFalse(gate.spendMatch("req", "nyaarium", 3L))
		}
	}

	@Test
	fun onlyAPromptPassedUnderEveryApprovalMintsACarryAndAReceiptMintsOne() = runBlocking {
		val gate = gate()

		// A window's prompt carries nothing.
		policy = VAULT_UNLOCK_WINDOW
		val windowed = gate.require(null) as Presence.Asked
		policy = VAULT_UNLOCK_EVERY
		gate.grantMatch(windowed.receipt, "req", "nyaarium", 3L)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		// Relocked between the prompt and the match.
		val relocked = gate.require(null) as Presence.Asked
		lockEpoch++
		gate.grantMatch(relocked.receipt, "req", "nyaarium", 3L)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		// One receipt, one carry.
		val once = gate.require(null) as Presence.Asked
		gate.grantMatch(once.receipt, "req", "nyaarium", 3L)
		assertTrue(gate.spendMatch("req", "nyaarium", 3L))
		gate.grantMatch(once.receipt, "req", "nyaarium", 3L)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))

		// A receipt nobody minted.
		gate.grantMatch(object : PresenceReceipt {}, "req", "nyaarium", 3L)
		assertFalse(gate.spendMatch("req", "nyaarium", 3L))
	}
}
