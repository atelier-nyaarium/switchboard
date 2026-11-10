package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SessionHarness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContainerRulesTest {
	private fun container(run: ContainerRun?, harnesses: SpawnHarnesses = SpawnHarnesses.Unknown) =
		SpawnContainer("app", run, failure = null, harnesses)

	private fun buttons(run: ContainerRun?, harnesses: SpawnHarnesses = SpawnHarnesses.Unknown, reachable: Boolean = true) =
		containerButtons(container(run, harnesses), reachable, inFlight = false)

	@Test
	fun theHeaderOffersStartWhileStoppedAndCreateOnlyWhileRunningWithACli() {
		val none = ContainerButtons(start = false, stop = false, create = false, busy = false, building = false)

		assertEquals(none.copy(start = true), buttons(ContainerRun.STOPPED))
		assertEquals(none.copy(stop = true, building = true), buttons(ContainerRun.STARTING))
		assertEquals(none.copy(stop = true, create = true), buttons(ContainerRun.RUNNING))
		assertEquals(none.copy(stop = true), buttons(ContainerRun.RUNNING, SpawnHarnesses.Known(emptySet())))
		assertEquals(none.copy(stop = true, create = true), buttons(ContainerRun.RUNNING, SpawnHarnesses.Known(setOf(SessionHarness.OPENCODE))))
		// A newer state word, or a Gateway out of reach, draws nothing to press.
		assertEquals(none, buttons(null))
		assertEquals(none, buttons(ContainerRun.RUNNING, reachable = false))
		assertTrue(containerButtons(container(ContainerRun.STOPPED), reachable = true, inFlight = true).busy)
	}

	@Test
	fun stopNamesOnlyTheContainersSessionsThatAreNotIdle() {
		val sessions = listOf(
			testTeam("d.gw.app.idle", sessionLabel = "Idle"),
			testTeam("d.gw.app.turn", working = true),
			testTeam("d.gw.app.compact", compacting = true),
			testTeam("d.gw.app.ask", promptId = "p1"),
			testTeam("d.gw.app.limit", limitBlocked = true),
			testTeam("d.gw.app.agent", teammates = true),
			testTeam("d.gw.app.flow", workflow = true),
			// Asleep with a stale flag, another project, another Gateway.
			testTeam("d.gw.app.asleep", status = Presence.AVAILABLE, working = true),
			testTeam("d.gw.other.turn", working = true),
			testTeam("d.gw2.app.turn", working = true),
		)
		val inside = sessionsIn(sessions, "gw", "app")

		val ask = stopAsk("d.gw.app", inside) { it.substringAfterLast('.') }

		assertEquals(StopAsk("d.gw.app", listOf("turn", "compact", "ask", "limit", "agent", "flow")), ask)
		assertNull(stopAsk("d.gw.app", inside.take(1)) { it })
		assertFalse(inside.any { it.name == "d.gw.other.turn" || it.name == "d.gw2.app.turn" })
	}

	@Test
	fun createWaitsForARunningContainerOnlyWhereTheGatewayReportsContainers() {
		val reporting = testRegistry("gw", "old").withEntry("gw") {
			it.copy(containers = listOf(container(ContainerRun.RUNNING), SpawnContainer("idle", ContainerRun.STOPPED, null, SpawnHarnesses.Unknown)))
		}

		assertTrue(reporting.createsOn("gw", "host"))
		assertTrue(reporting.createsOn("gw", "app"))
		assertFalse(reporting.createsOn("gw", "idle"))
		assertFalse(reporting.createsOn("gw", "unlisted"))
		assertTrue(reporting.createsOn("old", "anything"))
	}

	@Test
	fun everyReportedContainerGetsAHeaderAfterTheSpawnRows() {
		assertEquals(
			listOf("b", "a", "c", "y", "z"),
			containerProjects(spawnRows = listOf("b", "a"), reported = listOf("c", "a"), orphans = setOf("z", "y")),
		)
	}
}
