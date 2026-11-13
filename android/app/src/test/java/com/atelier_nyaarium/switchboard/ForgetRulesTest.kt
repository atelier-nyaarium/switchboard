package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ForgetRulesTest {
	private val session = "d.gw.app.work"

	private fun row(run: ContainerRun?, failure: String? = null) =
		SpawnContainer("app", run, failure, SpawnHarnesses.UNOPENED_CONTAINER)

	private fun state(
		run: ContainerRun? = ContainerRun.RUNNING,
		connected: Boolean = true,
		provenance: RegistryProvenance = RegistryProvenance.Current,
	) = ChatState(
		gateways = testRegistry("gw", provenance = provenance)
			.withEntry("gw") { it.copy(connected = connected, containers = listOf(row(run))) },
	)

	@Test
	fun aForgetAsksOnlyWhenItsDataCannotBePurgedNow() {
		assertEquals(ForgetAsk.None, forgetAsk(state(), session))
		assertEquals(ForgetAsk.ContainerStopped("d.gw.app"), forgetAsk(state(ContainerRun.STOPPED), session))
		// A start under way purges once it is up.
		assertEquals(ForgetAsk.None, forgetAsk(state(ContainerRun.STARTING), session))
		// A host session has no container.
		assertEquals(ForgetAsk.None, forgetAsk(state(ContainerRun.STOPPED), "d.gw.host.work"))
		assertEquals(ForgetAsk.None, forgetAsk(state(), "not a target"))
	}

	@Test
	fun theOfflineAskNeedsACurrentRosterThatSaysDisconnected() {
		assertEquals(ForgetAsk.GatewayOffline, forgetAsk(state(connected = false), session))
		// Offline outranks a container state last heard before it dropped.
		assertEquals(ForgetAsk.GatewayOffline, forgetAsk(state(ContainerRun.STOPPED, connected = false), session))
		// A roster still read from cache says nothing about now.
		assertEquals(ForgetAsk.None, forgetAsk(state(connected = false, provenance = RegistryProvenance.Cached), session))
	}

	@Test
	fun theAskSaysWhatForgetAnywayDoes() {
		assertEquals(CONTAINER_STOPPED_TITLE, forgetAskTitle(ForgetAsk.ContainerStopped("d.gw.app")))
		assertEquals(CONTAINER_STOPPED_LINE, forgetAskLine(ForgetAsk.ContainerStopped("d.gw.app")))
		assertEquals(GATEWAY_OFFLINE_TITLE, forgetAskTitle(ForgetAsk.GatewayOffline))
		assertEquals(GATEWAY_OFFLINE_LINE, forgetAskLine(ForgetAsk.GatewayOffline))
	}

	@Test
	fun aHeldForgetSettlesOnRunningOrOnAFailedStart() {
		val stopped = row(ContainerRun.STOPPED)
		// Pressed and not yet answered.
		assertNull(containerSettle(stopped, stopped, inFlight = true))
		assertNull(containerSettle(stopped, row(ContainerRun.STARTING), inFlight = false))
		assertEquals(ContainerSettle.Running, containerSettle(stopped, row(ContainerRun.RUNNING), inFlight = false))
		assertEquals(
			ContainerSettle.Failed("devcontainer up exited 1"),
			containerSettle(stopped, row(ContainerRun.STOPPED, "devcontainer up exited 1"), inFlight = false),
		)
		// A Start the Gateway never took.
		assertEquals(ContainerSettle.Failed(CONTAINER_START_FAILED), containerSettle(stopped, stopped, inFlight = false))
		// The same failure as last time is still a failure.
		val failed = row(ContainerRun.STOPPED, "port 5432 is taken")
		assertEquals(ContainerSettle.Failed("port 5432 is taken"), containerSettle(failed, failed, inFlight = false))
		assertEquals(ContainerSettle.Failed(CONTAINER_START_FAILED), containerSettle(stopped, null, inFlight = false))
	}

	@Test
	fun aHeldForgetDoesNothingForASessionForgottenMeanwhile() {
		val listed = ChatState(teams = listOf(testTeam(session, status = Presence.AVAILABLE)))
		val failed = ContainerSettle.Failed("devcontainer up exited 1")

		assertEquals(HeldForgetStep.Forget, heldForgetStep(listed, session, ContainerSettle.Running))
		assertEquals(HeldForgetStep.Keep("devcontainer up exited 1"), heldForgetStep(listed, session, failed))
		assertNull(heldForgetStep(ChatState(), session, ContainerSettle.Running))
		assertNull(heldForgetStep(ChatState(), session, failed))
	}
}
