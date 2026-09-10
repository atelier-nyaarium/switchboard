package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.PresencePlane
import com.atelier_nyaarium.switchboard.proto.RosterEntry
import com.atelier_nyaarium.switchboard.proto.TeamInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresenceOpsTest {
	private class FakeHost : PresenceHost {
		override val state = MutableStateFlow(ChatState())
		override val homeGatewayId = "local"
		override var storedDisplayName = ""
		override val forgottenUntil = mutableMapOf<String, Long>()
		var slot: RouterStateSlot? = null
		var failSlotWrite = false
		var savedLabels: Map<String, String>? = null
		var savedAbsence: Map<String, Int>? = null

		override suspend fun <T> withDrainMutex(block: suspend () -> T): T = block()
		override suspend fun reportRead(team: String, anchor: ReadAnchor) = Unit
		override suspend fun pullPlanes(everything: Boolean) = Unit
		override fun storedRunbooks(gatewayId: String): List<com.atelier_nyaarium.switchboard.proto.Runbook>? = null
		override fun loadRouterState(kind: String) = slot
		override fun saveRouterState(kind: String, slot: RouterStateSlot) {
			if (failSlotWrite) error("storage fault")
			this.slot = slot
		}
		override fun persistLabels(labels: Map<String, String>) { savedLabels = labels }
		override fun persistAbsenceStreaks(streaks: Map<String, Int>) { savedAbsence = streaks }
		override fun persistReadAnchors(anchors: Map<String, ReadAnchor>) = Unit
		override fun receiptFor(team: String, now: Long): ActionReceipt? = null
		override fun clearReceipt(team: String) = Unit
	}

	private fun info(
		name: String,
		gatewayId: String = "local",
		domainId: String = "d",
		status: String = Presence.ONLINE,
	) = TeamInfo(
		team = name,
		gatewayId = gatewayId,
		domainId = domainId,
		status = status,
		kind = "loose",
		queue_depth = 0,
	)

	private fun projection(
		version: Long,
		name: String = "host.session",
		rows: List<TeamInfo> = listOf(info(name)),
		roster: List<RosterEntry> = listOf(RosterEntry("local", true, 1, 1)),
		spawnPoints: List<GatewaySpawnPoints> = emptyList(),
		owner: OwnerFacts = OwnerFacts("d", null, false),
	) = OwnerPresenceProjection(
		plane = PresencePlane(epoch = 1, version = version),
		owner = owner,
		rows = rows,
		linked = emptyList(),
		roster = roster,
		coverage = DiscoverCoverage(rosterKnown = true, asked = 1, answered = 1),
		spawnPoints = spawnPoints,
	)

	private val windowsOnMikan = listOf(
		GatewaySpawnPoints(gatewayId = "mikan", hostSpawns = listOf("windows"), domainId = "d"),
	)

	private val withMikan = listOf(RosterEntry("local", true, 1, 1), RosterEntry("mikan", true, 1, 1))

	@Test
	fun projectedSpawnPointsReachThePickerAndLeaveWhenAGatewayStopsAdvertising() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		ops.applyOwnerProjection(projection(1, roster = withMikan, spawnPoints = windowsOnMikan))
		assertEquals(listOf("windows", "host"), hostSpawnChoices(host.state.value.gateways.hostSpawns("mikan")))

		ops.applyOwnerProjection(projection(2, roster = withMikan))
		assertEquals(listOf("host"), hostSpawnChoices(host.state.value.gateways.hostSpawns("mikan")))

		val restoredHost = FakeHost()
		val stored = projection(1, roster = withMikan, spawnPoints = windowsOnMikan)
		restoredHost.slot = RouterStateSlot(1, 1, wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), stored))
		PresenceOps(restoredHost).restoreLastProjection()
		assertEquals(listOf("windows"), restoredHost.state.value.gateways.hostSpawns("mikan"))
	}

	@Test
	fun restoreLastProjectionLandsBeforePollingAndPollWinsAfterward() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		val held = projection(1, "host.held", roster = withMikan, spawnPoints = windowsOnMikan)
		host.slot = RouterStateSlot(1, 1, wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), held))
		ops.restoreLastProjection()
		assertEquals(listOf("d.local.host.held"), host.state.value.teams.map { it.name })
		assertEquals(listOf("windows"), host.state.value.gateways.hostSpawns("mikan"))

		ops.applyOwnerProjection(projection(2, "host.live"))
		host.slot = RouterStateSlot(1, 1, wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), held))
		ops.restoreLastProjection()

		assertEquals(listOf("d.local.host.live"), host.state.value.teams.map { it.name })
	}

	@Test
	fun theRosterIsCachedFromTheSlotAndCurrentFromTheRouter() = runBlocking {
		val host = FakeHost()
		val stored = projection(1, roster = withMikan)
		host.slot = RouterStateSlot(1, 1, wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), stored))
		val ops = PresenceOps(host)
		assertEquals(RegistryProvenance.NeverLoaded, host.state.value.gateways.provenance)

		ops.restoreLastProjection()
		assertEquals(RegistryProvenance.Cached, host.state.value.gateways.provenance)
		assertEquals(listOf("local", "mikan"), host.state.value.gateways.ids())

		ops.applyOwnerProjection(stored)
		assertEquals(RegistryProvenance.Current, host.state.value.gateways.provenance)

		val broken = FakeHost()
		broken.slot = RouterStateSlot(1, 1, JsonNull)
		val brokenOps = PresenceOps(broken)
		brokenOps.restoreLastProjection()
		assertEquals(RegistryProvenance.NeverLoaded, broken.state.value.gateways.provenance)
		brokenOps.applyOwnerProjection(stored)
		assertEquals(RegistryProvenance.Current, broken.state.value.gateways.provenance)
		assertEquals(host.slot, broken.slot)

		host.state.update { it.copy(gateways = it.gateways.withEntry("mikan") { e -> e.copy(routineZone = "Europe/London") }) }
		ops.applyOwnerProjection(projection(2, roster = withMikan))
		assertEquals(RegistryProvenance.Current, host.state.value.gateways.provenance)
		assertEquals("Europe/London", host.state.value.gateways.entry("mikan")?.routineZone)
		ops.applyOwnerProjection(projection(3))
		assertEquals(listOf("local"), host.state.value.gateways.ids())
	}

	@Test
	fun aLiveProjectionRenamesTheOwnerAndACachedOneCannotUndoIt() = runBlocking {
		val host = FakeHost()
		PresenceOps(host).applyOwnerProjection(projection(2, owner = OwnerFacts("d", "Alicia", true)))
		assertEquals("Alicia", host.storedDisplayName)
		assertEquals(OwnerFacts("d", "Alicia", true), host.state.value.owner)

		val cached = projection(1, owner = OwnerFacts("d", "Alice", true))
		host.slot = RouterStateSlot(1, 1, wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), cached))
		PresenceOps(host).restoreLastProjection()
		assertEquals("Alicia", host.storedDisplayName)
		assertEquals(OwnerFacts("d", "Alicia", true), host.state.value.owner)
	}

	@Test
	fun newerOwnerProjectionAppliesAndPersistsTheSlot() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		ops.applyOwnerProjection(projection(2))
		assertEquals(2L, host.slot?.version)
		assertEquals(listOf("d.local.host.session"), host.state.value.teams.map { it.name })
	}

	@Test
	fun slotWriteFaultStillAppliesProjectionInMemory() = runBlocking {
		val host = FakeHost().also { it.failSlotWrite = true }
		PresenceOps(host).applyOwnerProjection(projection(1))
		assertEquals(1, host.state.value.teams.size)
		assertNull(host.slot)
	}

}
