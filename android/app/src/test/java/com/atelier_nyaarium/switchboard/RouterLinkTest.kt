package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class RouterLinkTest {
	private fun refusedFor(reason: String) = buildJsonObject {
		put("outcome", Protocol.Wire.OP_OUTCOME_REFUSED)
		put("reason", reason)
	}

	@Test
	fun startingOverForgetsEverythingWitnessed() {
		val worn = linkAfter(RouterEvent.Accepted, RouterEvent.SetupSettled, RouterEvent.Refused(Refusal.CLOCK_SKEW), RouterEvent.Missed(Miss.UNREACHABLE))
		assertEquals(RouterLink.none, linkAfter(RouterEvent.Accepted, RouterEvent.SetupSettled, RouterEvent.SetupOwed))
		assertEquals(false, worn == RouterLink.none)
	}

	@Test
	fun aStatusIsReadForWhatItSaysOfThisDevice() {
		assertEquals(RouterEvent.Reached, eventOfStatus(200))
		// An enroll op answers its own refusal with 400.
		assertEquals(RouterEvent.Reached, eventOfStatus(400))
		assertEquals(RouterEvent.Refused(Refusal.OUT_OF_DATE), eventOfOwnerOpStatus(400))
		assertEquals(RouterEvent.Refused(Refusal.TOKEN_REJECTED), eventOfStatus(401))
		assertEquals(RouterEvent.Refused(Refusal.NOT_SET_UP), eventOfOwnerOpStatus(404))
		assertEquals(RouterEvent.Missed(Miss.SERVER_FAULT), eventOfStatus(503))
	}

	@Test
	fun aThrownTripIsReadByItsType() {
		val pinned = javax.net.ssl.SSLHandshakeException("handshake").apply { initCause(java.security.cert.CertificateException("pin")) }
		assertEquals(RouterEvent.Refused(Refusal.CERT_CHANGED), eventOfFailure(pinned))
		// A dropped handshake is not a changed certificate.
		assertEquals(RouterEvent.Missed(Miss.INTERRUPTED), eventOfFailure(javax.net.ssl.SSLHandshakeException("connection closed")))
		assertEquals(RouterEvent.Missed(Miss.NO_NETWORK), eventOfFailure(java.net.UnknownHostException("router")))
		assertEquals(RouterEvent.Missed(Miss.UNREACHABLE), eventOfFailure(java.net.SocketTimeoutException("timeout")))
	}

	@Test
	fun anOwnerAnswerNamesOnlyTheRefusalsThatSpeakOfThisDevice() {
		assertEquals(RouterEvent.Accepted, eventOfOwnerAnswer(JsonArray(emptyList())))
		assertEquals(RouterEvent.Accepted, eventOfOwnerAnswer(buildJsonObject { put("outcome", Protocol.Wire.OP_OUTCOME_ACCEPTED) }))
		assertEquals(RouterEvent.Refused(Refusal.NOT_ADMITTED), eventOfOwnerAnswer(refusedFor(Protocol.Wire.OP_REASON_NOT_ADMITTED)))
		assertEquals(RouterEvent.Refused(Refusal.CLOCK_SKEW), eventOfOwnerAnswer(refusedFor(Protocol.Wire.OP_REASON_CLOCK_SKEW)))
		// Refused past the admission check.
		assertEquals(RouterEvent.Accepted, eventOfOwnerAnswer(refusedFor("no_holder")))
	}
}
