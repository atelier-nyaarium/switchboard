package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.PresencePlane
import com.atelier_nyaarium.switchboard.proto.RosterEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayRegistryTest {
	private fun projection(incarnation: Long, connected: Boolean) = OwnerPresenceProjection(
		plane = PresencePlane(epoch = 1, version = incarnation + 1),
		owner = OwnerFacts("d", null, false),
		rows = emptyList(),
		linked = emptyList(),
		roster = listOf(RosterEntry("gw-a", connected, incarnation, incarnation)),
		coverage = DiscoverCoverage(rosterKnown = true, asked = 1, answered = 1),
		spawnPoints = emptyList(),
	)

	@Test
	fun aRosterUpdateKeepsEveryAnswerOfTheSameIncarnationAndARestartKeepsOnlyItsPeers() {
		val peers = GatewayList.Listed(emptyList<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>())
		val answered = testRegistry("gw-a").withEntry("gw-a") {
			it.copy(
				routines = GatewayList.Listed(emptyList()),
				runbooks = GatewayList.Listed(emptyList()),
				policies = GatewayList.Listed(emptyList()),
				automations = GatewayList.Listed(emptyList()),
				automationServes = SANDBOX_SERVES,
				peers = peers,
				assistant = AssistantWord.Refused,
			)
		}

		val same = answered.landed(projection(1, connected = false), RegistryProvenance.Current) { null }.entry("gw-a")
		val restarted = answered.landed(projection(2, connected = true), RegistryProvenance.Current) { null }.entry("gw-a")

		assertEquals(answered.entry("gw-a")?.copy(connected = false), same)
		assertEquals(GatewayEntry("gw-a", connected = true, incarnation = 2, lastRegisteredAt = 2, peers = peers), restarted)
	}
}
