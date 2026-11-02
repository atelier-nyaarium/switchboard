package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.plugins.phone.stampedFor
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
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
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
		assertEquals(listOf("contacts"), denied.missing)

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
	fun anUnreadableJournalFileIsReplacedAtLoad() = runBlocking {
		val store = MemoryStore().apply { raw = "{\"runs\":[{\"requestId\":\"call-1234\"}]}" }
		val journal = PhoneCapabilityJournal(store, ManualTimer(), now = { 100_000L })

		assertTrue(journal.all().isEmpty())
		assertFalse(store.raw.orEmpty().contains("call-1234"))
	}

	@Test
	fun executeAnswersFromTheFeatureSwitchThenTheGrantThenTheHandler() = runBlocking {
		val store = MemoryStore()
		val self = HoldSelf.of(Crypto.Identity(Crypto.KeyPairRaw("phone-a", ""), Crypto.KeyPairRaw("", "")))
		val state = ChatState(phoneHold = PhoneHold("phone-a", "Phone A", 100_000L, 1L))
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
		val platform = FakePlatform()
		val sent = Channel<ConsoleOp.PhoneCapabilityAnswer>(Channel.UNLIMITED)
		val ops = PhoneCapabilityOps(
			platform = platform,
			state = { state },
			self = { self },
			scope = scope,
			store = store,
			send = { _, op, _ ->
				sent.send(op)
				ConsoleClient.ValueAnswer.Answered(JsonObject(emptyMap()))
			},
			now = { 100_000L },
			timer = ManualTimer(),
		)
		fun row(requestId: String, key: String) = PhoneCapabilityRow(requestId, key, JsonObject(emptyMap()), "none", 200_000L)

		try {
			ops.features.setWanted(Protocol.Wire.PhoneCapabilityKey.STATUS, true)
			ops.features.setWanted(Protocol.Wire.PhoneCapabilityKey.CONTACTS_SEARCH, true)
			ops.features.setWanted(Protocol.Wire.PhoneCapabilityKey.CALENDAR_EVENTS, true)
			ops.features.setWanted(Protocol.Wire.PhoneCapabilityKey.NOTIFICATIONS_RECENT, true)
			ops.enqueue("gateway-a", "team-a", row("call-0001", Protocol.Wire.PhoneCapabilityKey.STATUS))
			ops.enqueue("gateway-a", "team-a", row("call-0002", Protocol.Wire.PhoneCapabilityKey.TORCH))
			ops.enqueue("gateway-a", "team-a", row("call-0003", Protocol.Wire.PhoneCapabilityKey.CONTACTS_SEARCH))
			ops.enqueue("gateway-a", "team-a", row("call-0004", Protocol.Wire.PhoneCapabilityKey.CALENDAR_EVENTS))
			ops.enqueue("gateway-a", "team-a", row("call-0005", Protocol.Wire.PhoneCapabilityKey.NOTIFICATIONS_RECENT))
			val answers = withTimeout(5_000L) { List(5) { sent.receive() } }.associate { it.requestId to it.answer }

			assertEquals(PhoneCapabilityAnswer.Ok(JsonObject(emptyMap())), answers["call-0001"])
			val off = answers["call-0002"] as PhoneCapabilityAnswer.Unavailable
			assertEquals("disabled", off.reason)
			assertEquals(emptyList<String>(), off.needs)
			assertEquals(PhoneCapabilityAnswer.Unavailable("not_granted", listOf("contacts")), answers["call-0003"])
			assertEquals(PhoneCapabilityAnswer.Unavailable("not_granted", listOf("calendar")), answers["call-0004"])
			assertEquals(
				PhoneCapabilityAnswer.Unavailable("not_granted", listOf("notification_access")),
				answers["call-0005"],
			)
			assertEquals(listOf(Protocol.Wire.PhoneCapabilityKey.STATUS), platform.runs)
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun guardedTelephonyAnswersDeniedNeedsThroughDelivery() = runBlocking {
		val self = HoldSelf.of(Crypto.Identity(Crypto.KeyPairRaw("phone-a", ""), Crypto.KeyPairRaw("", "")))
		val state = ChatState(phoneHold = PhoneHold("phone-a", "Phone A", 100_000L, 1L))
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
		val platform = FakePlatform()
		val sent = Channel<ConsoleOp.PhoneCapabilityAnswer>(Channel.UNLIMITED)
		val ops = PhoneCapabilityOps(
			platform = platform,
			state = { state },
			self = { self },
			scope = scope,
			store = MemoryStore(),
			send = { _, op, _ ->
				sent.send(op)
				ConsoleClient.ValueAnswer.Answered(JsonObject(emptyMap()))
			},
			now = { 100_000L },
			timer = ManualTimer(),
		)
		val smsKey = Protocol.Wire.PhoneCapabilityKey.SMS_SEND
		val callKey = Protocol.Wire.PhoneCapabilityKey.CALL
		val smsRow = PhoneCapabilityRow("call-sms-0001", smsKey, JsonObject(emptyMap()), "approved", 200_000L)
		val callRow = PhoneCapabilityRow("call-call-0001", callKey, JsonObject(emptyMap()), "approved", 200_000L)

		try {
			ops.features.setWanted(smsKey, true)
			ops.features.setWanted(callKey, true)
			ops.enqueue("gateway-a", "team-a", smsRow)
			ops.enqueue("gateway-a", "team-a", callRow)

			val answers = withTimeout(5_000L) { List(2) { sent.receive() } }.associate { it.requestId to it.answer }
			assertEquals(
				PhoneCapabilityAnswer.Unavailable("not_granted", listOf("send_sms")),
				answers[smsRow.requestId],
			)
			assertEquals(
				PhoneCapabilityAnswer.Unavailable("not_granted", listOf("call_phone")),
				answers[callRow.requestId],
			)
			assertTrue(platform.runs.isEmpty())
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun listenerSettingGrantsNotificationCapabilities() {
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
		val platform = FakePlatform()
		val ops = PhoneCapabilityOps(
			platform = platform,
			state = { ChatState() },
			self = { null },
			scope = scope,
			store = MemoryStore(),
			send = { _, _, _ -> ConsoleClient.ValueAnswer.Answered(JsonObject(emptyMap())) },
			now = { 100_000L },
			timer = ManualTimer(),
		)
		val key = Protocol.Wire.PhoneCapabilityKey.NOTIFICATIONS_RECENT

		try {
			ops.features.setWanted(key, true)
			assertEquals("not_granted", ops.permissionState(key).reason)

			platform.listenerAccess = true

			assertTrue(ops.grants(key).available)
			assertTrue(ops.permissionState(key).available)
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun launchActAnswersNotShowingThroughDelivery() = runBlocking {
		val self = HoldSelf.of(Crypto.Identity(Crypto.KeyPairRaw("phone-a", ""), Crypto.KeyPairRaw("", "")))
		val state = ChatState(phoneHold = PhoneHold("phone-a", "Phone A", 100_000L, 1L))
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
		val platform = FakePlatform().apply {
			notifications = true
			launchAllowed = false
		}
		val sent = Channel<ConsoleOp.PhoneCapabilityAnswer>(Channel.UNLIMITED)
		val ops = PhoneCapabilityOps(
			platform = platform,
			state = { state },
			self = { self },
			scope = scope,
			store = MemoryStore(),
			send = { _, op, _ ->
				sent.send(op)
				ConsoleClient.ValueAnswer.Answered(JsonObject(emptyMap()))
			},
			now = { 100_000L },
			timer = ManualTimer(),
		)
		val key = Protocol.Wire.PhoneCapabilityKey.MAPS_OPEN
		val row = PhoneCapabilityRow(
			"call-0006",
			key,
			JsonObject(mapOf("query" to JsonPrimitive("coffee"))),
			"none",
			200_000L,
		)

		try {
			ops.features.setWanted(key, true)
			ops.enqueue("gateway-a", "team-a", row)

			val answer = withTimeout(5_000L) { sent.receive() }
			assertEquals(row.requestId, answer.requestId)
			assertEquals(PhoneCapabilityAnswer.Unavailable("not_showing"), answer.answer)
		} finally {
			scope.cancel()
		}
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

	/** Nothing granted; torch present. */
	private class FakePlatform : PhoneCapabilityPlatform {
		val runs = java.util.concurrent.CopyOnWriteArrayList<String>()
		var listenerAccess = false
		var notifications = false
		var launchAllowed = true
		override fun granted(manifestPermission: String): Boolean =
			manifestPermission == "android.permission.POST_NOTIFICATIONS" && notifications
		override fun listenerEnabled(): Boolean = listenerAccess
		override fun hasTorch(): Boolean = true
		override fun canLaunch(): Boolean = launchAllowed
		override suspend fun run(
			binding: PhoneCapabilityBinding,
			params: JsonElement,
			permissionState: (String) -> CapabilityAvailability,
		): PhoneCapabilityAnswer {
			runs += binding.key
			if (binding.kind == "act" && !canLaunch()) {
				return binding.run(
					PhoneCapabilityContext(android.content.ContextWrapper(null), { ChatState() }, permissionState, ::canLaunch),
					params,
				)
			}
			return PhoneCapabilityAnswer.Ok(JsonObject(emptyMap()))
		}
		override fun trace(label: String, requestId: String) = Unit
	}

	private class MemoryStore : PhoneCapabilityStore {
		var raw: String? = null
		var features: String? = null
		override fun loadPhoneCapabilityRuns(): String? = raw
		override fun savePhoneCapabilityRuns(json: String): Boolean {
			raw = json
			return true
		}
		override fun loadAssistantFeatures(): String? = features
		override fun saveAssistantFeatures(json: String): Boolean {
			features = json
			return true
		}
	}
}
