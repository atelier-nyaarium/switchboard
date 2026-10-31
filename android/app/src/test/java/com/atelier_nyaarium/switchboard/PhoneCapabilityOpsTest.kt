package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityAnswer
import com.atelier_nyaarium.switchboard.plugins.phone.stampedFor
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityRow
import com.atelier_nyaarium.switchboard.proto.RowStamp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
		val row = PhoneCapabilityRow("call-1234", "torch", JsonObject(emptyMap()), "none", 99_000L)
		val journal = PhoneCapabilityJournal(store)

		val first = journal.begin("gateway-a", "team-a", row)
		assertTrue(first is PhoneCapabilityRunStart.Started)
		assertEquals(CapabilityRunDecision.TIMEOUT, capabilityRunDecision((first as PhoneCapabilityRunStart.Started).run))

		val replay = PhoneCapabilityJournal(store).begin("gateway-a", "team-a", row)
		assertTrue(replay is PhoneCapabilityRunStart.Existing)
		assertEquals(CapabilityRunDecision.TIMEOUT, capabilityRunDecision((replay as PhoneCapabilityRunStart.Existing).run))

		val answered = journal.answer(row.requestId, PhoneCapabilityAnswer.Unavailable("timeout"))
		assertEquals(CapabilityRunDecision.REPLAY, capabilityRunDecision(answered))
	}

	@Test
	fun onlyThisPhonesStampRunsARow() {
		assertTrue(stampedFor(RowStamp("phone-a"), "phone-a"))
		assertFalse(stampedFor(RowStamp("phone-b"), "phone-a"))
		assertFalse(stampedFor(null, "phone-a"))
	}

	@Test
	fun aRefusedAnswerStopsTheRetriesAndSilenceDoesNot() {
		assertTrue(answeredByGateway(true))
		assertTrue(answeredByGateway(false))
		assertFalse(answeredByGateway(null))
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
