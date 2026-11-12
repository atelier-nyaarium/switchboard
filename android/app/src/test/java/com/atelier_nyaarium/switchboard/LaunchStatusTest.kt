package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchStatusTest {
	private val team = "dom.gw.app.new"
	private val failed = LaunchError("Devcontainer failed to start.", 7L)

	private fun row(kind: String = "notice", launch: String? = "failed", body: String? = failed.line) =
		MailboxEntry(seq = 1L, at = 7L, kind = kind, session_id = "notice.$team", body = body, launch = launch)

	@Test
	fun onlyAFailedLaunchsNoticeIsDocked() {
		assertEquals(failed, launchErrorOf(row()))
		assertNull(launchErrorOf(row(launch = null)))
		assertNull(launchErrorOf(row(kind = "message")))
		assertNull(launchErrorOf(row(body = " ")))
	}

	@Test
	fun aFailedLaunchIsHeldUntilDismissedOrTheSessionIsUp() {
		val state = MutableStateFlow(ChatState(teams = listOf(testTeam(team, status = Presence.AVAILABLE))))

		assertTrue(state.holdLaunchError(team, failed))
		assertEquals(failed, state.value.launchErrors[team])
		assertEquals(emptyMap<String, LaunchError>(), state.value.withFreshTeams(listOf(testTeam(team))).launchErrors)

		state.dismissLaunchError(team)
		assertEquals(emptyMap<String, LaunchError>(), state.value.launchErrors)
	}

	@Test
	fun aRowForASessionThatIsAlreadyUpIsNotHeld() {
		val state = MutableStateFlow(ChatState(teams = listOf(testTeam(team))))

		assertFalse(state.holdLaunchError(team, failed))
		assertEquals(emptyMap<String, LaunchError>(), state.value.launchErrors)
	}

	@Test
	fun aSessionKnownOnlyByItsFailedLaunchStillHasACardAndSettlesItsSpawn() {
		val held = ChatState(launchErrors = mapOf(team to failed))

		assertEquals(listOf(team), held.sessions().map { it.name })
		assertTrue(spawnSettled(held, team))
		assertFalse(spawnSettled(ChatState(), team))
		assertEquals(failed.line, sessionCardPreview(held, team, null).headline)
	}

	@Test
	fun aLaunchAlertIsStaleOnceItsFailureIsNoLongerHeld() {
		val other = "dom.gw.app.other"
		val showing = listOf(
			ServiceNotifications.launchFailedNotificationId(team),
			ServiceNotifications.launchFailedNotificationId(other),
			ServiceNotifications.scheduledSendFailedNotificationId(team),
		)

		assertEquals(
			listOf(ServiceNotifications.launchFailedNotificationId(other)),
			ServiceNotifications.staleLaunchNotifications(showing, held = setOf(team)),
		)
	}

	@Test
	fun theStartingDockShowsWhileBootingUnlessASendIsAlreadyWaking() {
		assertTrue(startingDock(SessionWord.VERIFYING, sendAwaitingWake = false, paneWorking = false))
		assertTrue(startingDock(SessionWord.WAKING, sendAwaitingWake = false, paneWorking = false))
		assertFalse(startingDock(SessionWord.WAKING, sendAwaitingWake = true, paneWorking = false))
		assertFalse(startingDock(SessionWord.LIVE, sendAwaitingWake = false, paneWorking = false))
		assertFalse(startingDock(null, sendAwaitingWake = false, paneWorking = false))
	}

	@Test
	fun theStartingDockNamesTheContainerItWaitsOn() {
		assertEquals("Starting container...", startingDockLine(SessionWord.WAKING, ContainerRun.STARTING))
		assertEquals("Starting...", startingDockLine(SessionWord.WAKING, ContainerRun.RUNNING))
		assertEquals("Starting...", startingDockLine(SessionWord.VERIFYING, null))
	}

	@Test
	fun aSessionReconnectingMidTurnIsNotStarting() {
		assertFalse(startingDock(SessionWord.VERIFYING, sendAwaitingWake = false, paneWorking = true))
	}
}
