package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SessionHarness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContainerRulesTest {
	private fun container(run: ContainerRun?, harnesses: SpawnHarnesses = SpawnHarnesses.UNOPENED_CONTAINER) =
		SpawnContainer("app", run, failure = null, harnesses)

	private fun buttons(run: ContainerRun?, harnesses: SpawnHarnesses = SpawnHarnesses.UNOPENED_CONTAINER, reachable: Boolean = true) =
		containerButtons(container(run, harnesses), reachable, inFlight = false)

	@Test
	fun theHeaderOffersStartWhileStoppedAndCreateWheneverACliCanLaunch() {
		val none = ContainerButtons(start = false, stop = false, create = false, busy = false, building = false)

		// A create starts a stopped container itself.
		assertEquals(none.copy(start = true, create = true), buttons(ContainerRun.STOPPED))
		assertEquals(none.copy(stop = true, create = true, building = true), buttons(ContainerRun.STARTING))
		assertEquals(none.copy(stop = true, create = true), buttons(ContainerRun.RUNNING))
		assertEquals(none.copy(stop = true), buttons(ContainerRun.RUNNING, SpawnHarnesses.Known(emptySet())))
		assertEquals(none.copy(start = true), buttons(ContainerRun.STOPPED, SpawnHarnesses.Known(emptySet())))
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
	fun aSpawnPointsReadinessSaysWhatAPickOfItMeans() {
		val claude = SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE))
		val bare = SpawnHarnesses.Known(emptySet())
		val unopened = SpawnHarnesses.UNOPENED_CONTAINER

		assertEquals(SpawnReadiness.READY, spawnReadiness(container = null, claude))
		assertEquals(SpawnReadiness.NO_CLI, spawnReadiness(container = null, bare))
		assertEquals(SpawnReadiness.STOPPED, spawnReadiness(container(ContainerRun.STOPPED), unopened))
		assertEquals(SpawnReadiness.STARTING, spawnReadiness(container(ContainerRun.STARTING), unopened))
		assertEquals(SpawnReadiness.READY, spawnReadiness(container(ContainerRun.RUNNING), unopened))
		assertEquals(SpawnReadiness.NO_CLI, spawnReadiness(container(ContainerRun.RUNNING), bare))
		assertEquals(SpawnReadiness.NO_CLI, spawnReadiness(container(ContainerRun.STOPPED), bare))
		// A newer state word, whatever is inside.
		assertEquals(SpawnReadiness.UNREAD, spawnReadiness(container(null), claude))
	}

	@Test
	fun aRememberedPickPreselectsOnlyASpawnPointThatIsUp() {
		val choices = listOf(
			SpawnChoice("host", "host"),
			SpawnChoice("stopped", "stopped", readiness = SpawnReadiness.STOPPED),
			SpawnChoice("building", "building", readiness = SpawnReadiness.STARTING),
			SpawnChoice("bare", "bare", readiness = SpawnReadiness.NO_CLI),
		)

		assertEquals("host", initialChoice(openedOn = null, remembered = "host", choices))
		assertNull(initialChoice(openedOn = null, remembered = "stopped", choices))
		assertNull(initialChoice(openedOn = null, remembered = "building", choices))
		assertNull(initialChoice(openedOn = null, remembered = "gone", choices))
		assertNull(initialChoice(openedOn = null, remembered = null, choices))
		assertNull(initialChoice(openedOn = null, remembered = "host", emptyList()))
		// Its own header's Create is the owner choosing it.
		assertEquals("stopped", initialChoice(openedOn = "stopped", remembered = "host", choices))
		assertEquals("host", initialChoice(openedOn = "bare", remembered = "host", choices))
		assertNull(initialChoice(openedOn = "gone", remembered = null, choices))
	}

	@Test
	fun onlyARunningContainersCliListIsRead() {
		val row = { state: String -> com.atelier_nyaarium.switchboard.proto.ContainerState("app", state, clis = listOf("claude")) }

		assertEquals(SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE)), spawnContainerOf(row("running")).harnesses)
		assertEquals(SpawnHarnesses.UNOPENED_CONTAINER, spawnContainerOf(row("stopped")).harnesses)
		assertEquals(SpawnHarnesses.UNOPENED_CONTAINER, spawnContainerOf(row("starting")).harnesses)
		assertEquals(SpawnHarnesses.UNOPENED_CONTAINER, spawnContainerOf(row("a-newer-word")).harnesses)
	}

	@Test
	fun aSessionSaysItWaitsOnItsContainerOnlyWhileItLaunchesIntoOneThatIsNotUp() {
		val line = "Starting container"

		assertEquals(line, containerStartLine(SessionWord.WAKING, ContainerRun.STOPPED))
		assertEquals(line, containerStartLine(SessionWord.WAKING, ContainerRun.STARTING))
		assertEquals(line, containerStartLine(SessionWord.VERIFYING, ContainerRun.STARTING))
		// Up, a host session, or a session that is not launching.
		assertNull(containerStartLine(SessionWord.WAKING, ContainerRun.RUNNING))
		assertNull(containerStartLine(SessionWord.WAKING, null))
		assertNull(containerStartLine(SessionWord.AVAILABLE, ContainerRun.STOPPED))
		assertNull(containerStartLine(null, ContainerRun.STARTING))
	}

	@Test
	fun aContainerIsFoundByItsSpawnPointOrByASessionInsideIt() {
		val app = container(ContainerRun.STARTING)
		val state = ChatState(gateways = testRegistry("gw", "gw2").withEntry("gw") { it.copy(containers = listOf(app)) })

		assertEquals(app, containerAt(state, "d.gw.app"))
		assertEquals(app, containerAt(state, "d.gw.app.s1"))
		assertNull(containerAt(state, "d.gw.host.s1"))
		assertNull(containerAt(state, "d.gw2.app.s1"))
		assertNull(containerAt(state, "not an address"))
	}

	@Test
	fun everyReportedContainerGetsAHeaderAfterTheSpawnRows() {
		assertEquals(
			listOf("b", "a", "c", "y", "z"),
			containerProjects(spawnRows = listOf("b", "a"), reported = listOf("c", "a"), orphans = setOf("z", "y")),
		)
	}
}
