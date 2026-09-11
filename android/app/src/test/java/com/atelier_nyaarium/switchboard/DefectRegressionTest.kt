package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.buildJsonObject

class DefectRegressionTest {
	@Test
	fun unmatchedInlineFenceDoesNotDiscardTrailingSpeech() {
		assertEquals("prefix ``` broken trailing", SttsPlayer.stripUnspeakable("prefix ``` broken trailing"))
	}

	@Test
	fun unterminatedFenceIsOmitted() {
		assertEquals("before\n Code block omitted.", SttsPlayer.stripUnspeakable("before\n```kotlin\nsecret()"))
	}

	@Test
	fun crlfFenceIsOmitted() {
		assertEquals("before\r\n Code block omitted.", SttsPlayer.stripUnspeakable("before\r\n```kotlin\r\nsecret()\r\n```\r\n"))
	}

	@Test
	fun cacheFileUsesRowIdentity() {
		val root = java.io.File.createTempFile("stts", "test").apply { delete(); mkdirs() }
		try {
			val cache = SttsCache(root, PlaybackRequests(), java.util.concurrent.Executor { it.run() })
			val provider = com.atelier_nyaarium.switchboard.proto.SttsProvider(
				id = "p",
				label = "P",
				path = "p",
				hasSample = false,
				request = buildJsonObject {},
				defaults = com.atelier_nyaarium.switchboard.proto.SttsDefaults("voice"),
				voices = emptyList(),
				voiceHint = "voice",
			)
			val first = cache.cacheFile("team", 10L, SttsPlayer.Tier.FULL, provider, null, "same", "1-1")
			val second = cache.cacheFile("team", 10L, SttsPlayer.Tier.FULL, provider, null, "same", "1-2")
			assertTrue(first != second)
		} finally {
			root.deleteRecursively()
		}
	}

	@Test
	fun localityRequiresDomainAndGateway() {
		val address = com.atelier_nyaarium.switchboard.proto.Address.of("domain-a", "gateway-a", "session", "main")
		assertTrue(testRegistry("gateway-a").owns(address, "domain-a"))
		assertEquals(false, testRegistry("gateway-a").owns(address, "domain-b"))
		assertEquals(false, testRegistry("gateway-b").owns(address, "domain-a"))
	}

	@Test
	fun qualifiedRemoteAddressIsAnEligibleCloseTarget() {
		val target = com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget("domain-b.gateway-a.spawn.session")
		assertTrue(target.isCloseTabTarget())
	}

	@Test
	fun designerRelOfRejectsMalformedSource() {
		assertEquals("", com.atelier_nyaarium.switchboard.plugins.designer.relOf("not-an-attachment"))
	}
}
