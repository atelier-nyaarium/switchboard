package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class CrossDomainPresenceUiTest {
	@Test
	fun nullTimestampIsUnknown() {
		assertEquals(CrossDomainFreshness.UNKNOWN, crossDomainFreshness(null, now = 1_000_000))
	}

	@Test
	fun withinThresholdIsFresh() {
		val now = 1_000_000L
		assertEquals(
			CrossDomainFreshness.FRESH,
			crossDomainFreshness(now - CROSS_DOMAIN_STALE_THRESHOLD_MS, now, CROSS_DOMAIN_STALE_THRESHOLD_MS),
		)
	}

	@Test
	fun pastThresholdIsStale() {
		val now = 1_000_000L
		assertEquals(
			CrossDomainFreshness.STALE,
			crossDomainFreshness(now - CROSS_DOMAIN_STALE_THRESHOLD_MS - 1, now, CROSS_DOMAIN_STALE_THRESHOLD_MS),
		)
	}
}
