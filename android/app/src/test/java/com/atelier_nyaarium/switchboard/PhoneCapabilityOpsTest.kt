package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.plugins.phone.stampedFor
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityRow
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.RowStamp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneCapabilityOpsTest {
	@Test
	fun permissionStateReportsMissingNeedsAndAvailableState() {
		val denied = permissionState(listOf("contacts"), hasPermission = { false })
		assertFalse(denied.available)
		assertEquals("not_granted", denied.reason)
		assertEquals(listOf("contacts"), denied.needs)

		val granted = permissionState(listOf("contacts"), hasPermission = { true })
		assertTrue(granted.available)
		assertEquals(null, granted.reason)
		assertEquals(listOf("contacts"), granted.needs)
	}

	@Test
	fun theDurableRunMarkerMakesASecondDeliveryTimeoutWithoutStartingAgain() = runBlocking {
		val store = MemoryStore()
		val row = PhoneCapabilityRow("call-1234", "torch", JsonObject(emptyMap()), "none", 120_000L)
		val journal = PhoneCapabilityJournal(store, ManualTimer(), now = { 100_000L })

		val first = journal.begin("gateway-a", "team-a", row)
		assertTrue(first is PhoneCapabilityRunStart.Started)
		assertEquals(CapabilityRunDecision.TIMEOUT, capabilityRunDecision((first as PhoneCapabilityRunStart.Started).run))

		val replay = PhoneCapabilityJournal(store, ManualTimer(), now = { 100_000L }).begin("gateway-a", "team-a", row)
		assertTrue(replay is PhoneCapabilityRunStart.Existing)
		assertEquals(CapabilityRunDecision.TIMEOUT, capabilityRunDecision((replay as PhoneCapabilityRunStart.Existing).run))

		val answered = journal.answer(row.requestId, PhoneCapabilityAnswer.Unavailable("timeout"))
		assertEquals(CapabilityRunDecision.REPLAY, capabilityRunDecision(answered))
	}

	@Test
	fun anAnsweredRunReplaysAfterRetractionWithoutStartingAgain() = runBlocking {
		val store = MemoryStore()
		val now = 100_000L
		val row = PhoneCapabilityRow("call-1234", "torch", JsonObject(emptyMap()), "none", 200_000L)
		val answer = PhoneCapabilityAnswer.Unavailable("not_supported")
		val journal = PhoneCapabilityJournal(store, ManualTimer(), now = { now })
		var handlerRuns = 0

		val first = journal.begin("gateway-a", "team-a", row)
		if (first is PhoneCapabilityRunStart.Started) {
			handlerRuns += 1
			journal.answer(row.requestId, answer)
		}
		journal.retract(row.requestId)

		val retry = PhoneCapabilityJournal(store, ManualTimer(), now = { now }).begin("gateway-a", "team-a", row)
		assertTrue(retry is PhoneCapabilityRunStart.Existing)
		assertEquals(answer, (retry as PhoneCapabilityRunStart.Existing).run.answer)
		assertEquals(1, handlerRuns)
	}

	@Test
	fun theJournalPrunesAfterTheRestartGraceAndReplaysWithinIt() = runBlocking {
		val store = MemoryStore()
		var now = 100_000L
		val row = PhoneCapabilityRow("call-1234", "torch", JsonObject(emptyMap()), "none", 120_000L)
		val answer = PhoneCapabilityAnswer.Unavailable("timeout")
		val journal = PhoneCapabilityJournal(store, ManualTimer(), now = { now })
		val first = journal.begin("gateway-a", "team-a", row)
		assertTrue(first is PhoneCapabilityRunStart.Started)
		journal.answer(row.requestId, answer)
		journal.retract(row.requestId)

		now = row.deadlineAt + PHONE_CAPABILITY_RESTART_GRACE_MS - 1L
		val replay = journal.begin("gateway-a", "team-a", row)
		assertTrue(replay is PhoneCapabilityRunStart.Existing)
		assertEquals(answer, (replay as PhoneCapabilityRunStart.Existing).run.answer)

		now += 2L
		journal.retract("other-1234")
		assertFalse(store.raw.orEmpty().contains(row.requestId))
		assertTrue(journal.begin("gateway-a", "team-a", row) is PhoneCapabilityRunStart.NotStored)
		val fresh = row.copy(deadlineAt = now + 60_000L)
		assertTrue(journal.begin("gateway-a", "team-a", fresh) is PhoneCapabilityRunStart.Started)
	}

	@Test
	fun aFarDeadlineCannotExtendRetentionPastThePhoneWaitAndGrace() = runBlocking {
		val store = MemoryStore()
		val startAt = 100_000L
		var now = startAt
		val timer = ManualTimer()
		val row = PhoneCapabilityRow(
			"call-1234",
			"torch",
			JsonObject(emptyMap()),
			"none",
			startAt + Protocol.Wire.PHONE_CAPABILITY_WAIT_MS.toLong() * 10L,
		)
		val journal = PhoneCapabilityJournal(store, timer, now = { now })
		assertTrue(journal.begin("gateway-a", "team-a", row) is PhoneCapabilityRunStart.Started)
		journal.answer(row.requestId, PhoneCapabilityAnswer.Unavailable("timeout"))

		now = startAt + Protocol.Wire.PHONE_CAPABILITY_WAIT_MS.toLong() + PHONE_CAPABILITY_RESTART_GRACE_MS - 1L
		assertTrue(journal.begin("gateway-a", "team-a", row) is PhoneCapabilityRunStart.Existing)

		now += 2L
		timer.fire()
		assertTrue(journal.begin("gateway-a", "team-a", row) is PhoneCapabilityRunStart.Started)
	}

	@Test
	fun anActionRetractedBeforeBindingRunsNoHandler() = runBlocking {
		val store = MemoryStore()
		val row = PhoneCapabilityRow("call-1234", "torch", JsonObject(emptyMap()), "none", 200_000L)
		val journal = PhoneCapabilityJournal(store, ManualTimer(), now = { 100_000L })
		assertTrue(journal.begin("gateway-a", "team-a", row) is PhoneCapabilityRunStart.Started)
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
		var handlerRuns = 0

		try {
			journal.scheduleRetraction(row.requestId, scope)
			val answer = journal.runUnlessRetracted(row.requestId) {
				handlerRuns += 1
				PhoneCapabilityAnswer.Unavailable("not_supported")
			}
			assertNull(answer)
			assertEquals(0, handlerRuns)
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun idleJournalPersistsPruningAtTheRetentionCutoff() = runBlocking {
		val store = MemoryStore()
		var now = 100_000L
		val timer = ManualTimer()
		val row = PhoneCapabilityRow("call-1234", "torch", JsonObject(emptyMap()), "none", 120_000L)
		val journal = PhoneCapabilityJournal(store, timer, now = { now })
		assertTrue(journal.begin("gateway-a", "team-a", row) is PhoneCapabilityRunStart.Started)
		journal.answer(row.requestId, PhoneCapabilityAnswer.Unavailable("timeout"))
		assertTrue(store.raw.orEmpty().contains(row.requestId))

		now = row.deadlineAt + PHONE_CAPABILITY_RESTART_GRACE_MS + 1L
		timer.fire()

		assertFalse(store.raw.orEmpty().contains(row.requestId))
	}

	@Test
	fun onlyThisPhonesStampRunsARow() {
		val self = HoldSelf.of(Crypto.Identity(Crypto.KeyPairRaw("phone-a", ""), Crypto.KeyPairRaw("", "")))
		assertTrue(stampedFor(RowStamp("phone-a"), self))
		assertFalse(stampedFor(RowStamp("phone-b"), self))
		assertFalse(stampedFor(null, self))
	}

	@Test
	fun capabilityRefusesWhenPhoneIdentityIsUnavailable() {
		val hold = PhoneHold("phone-a", "Phone A", 100L, 1L)
		assertFalse(isCurrentPhoneHolder(hold, null, 101L))
	}

	@Test
	fun onlyDeliveredAnswersAndGatewayRefusalsStopRetries() {
		assertTrue(answerDeliverySettled(ConsoleClient.ValueAnswer.Answered(JsonObject(emptyMap()))))
		assertTrue(answerDeliverySettled(ConsoleClient.ValueAnswer.Refused("refused")))
		assertFalse(answerDeliverySettled(ConsoleClient.ValueAnswer.Undelivered("offline")))
		assertFalse(answerDeliverySettled(ConsoleClient.ValueAnswer.Unreachable))
	}

	private class ManualTimer : PhoneCapabilityJournalTimer {
		private data class Entry(val delayMs: Long, val job: Job, val task: suspend () -> Unit)

		private var latest: Entry? = null

		override fun schedule(delayMs: Long, task: suspend () -> Unit): Job {
			val job = Job()
			latest = Entry(delayMs, job, task)
			return job
		}

		suspend fun fire() {
			latest?.task?.invoke() ?: error("No timer scheduled")
		}
	}

	private class MemoryStore : PhoneCapabilityStore {
		var raw: String? = null
		override fun loadPhoneCapabilityRuns(): String? = raw
		override fun savePhoneCapabilityRuns(json: String): Boolean {
			raw = json
			return true
		}
	}
}
