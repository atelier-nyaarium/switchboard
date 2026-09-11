package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the Sessions tab may draw and offer for one Gateway, read from the roster alone. */
class GatewayStandingTest {
	private fun entry(id: String, connected: Boolean, incarnation: Long = 1, hostSpawns: List<String>? = listOf("host")) =
		GatewayEntry(id, connected = connected, incarnation = incarnation, lastRegisteredAt = 1, hostSpawns = hostSpawns)

	private fun registry(provenance: RegistryProvenance, vararg entries: GatewayEntry) =
		GatewayRegistry(provenance = provenance, epoch = 1, version = 1, gateways = entries.toList())

	@Test
	fun anUnloadedRosterKnowsNothingAndOffersNothing() {
		val never = registry(RegistryProvenance.NeverLoaded, entry("sakura", connected = true))
		assertEquals(GatewayStanding.Unknown, never.standing("sakura"))
		assertFalse(never.offersSpawn("sakura"))
	}

	@Test
	fun aCachedRosterStillOffersAConnectedProjectedGateway() {
		val cached = registry(RegistryProvenance.Cached, entry("sakura", connected = true))
		assertEquals(GatewayStanding.Online, cached.standing("sakura"))
		assertTrue(cached.offersSpawn("sakura"))
	}

	@Test
	fun aGatewayThatNeverRegisteredIsNeverSeenAndOffersNothing() {
		val current = registry(RegistryProvenance.Current, entry("ql-2815", connected = false, incarnation = 0, hostSpawns = null))
		assertEquals(GatewayStanding.NeverSeen, current.standing("ql-2815"))
		assertFalse(current.offersSpawn("ql-2815"))
	}

	@Test
	fun anOfflineGatewayIsOfflineAndOffersNothing() {
		val current = registry(RegistryProvenance.Current, entry("sakura", connected = false))
		assertEquals(GatewayStanding.Offline, current.standing("sakura"))
		assertFalse(current.offersSpawn("sakura"))
	}

	@Test
	fun aConnectedGatewayWithoutProjectedSpawnPointsIsOnlineButOffersNothing() {
		val current = registry(RegistryProvenance.Current, entry("sakura", connected = true, hostSpawns = null))
		assertEquals(GatewayStanding.Online, current.standing("sakura"))
		assertFalse(current.offersSpawn("sakura"))
	}

	@Test
	fun aGatewayTheRosterDoesNotNameIsUnknown() {
		val current = registry(RegistryProvenance.Current, entry("sakura", connected = true))
		assertEquals(GatewayStanding.Unknown, current.standing("gone"))
		assertFalse(current.offersSpawn("gone"))
	}
}
