package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.Runbook
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The reads the two tabs and their editors do. They live here rather than in a screen because
 * nothing can call into a `@Composable`, and a rule written inside one is invisible to every gate.
 */
class GatewayScopedStateTest {
	private fun book(id: String, name: String) =
		Runbook(id = id, name = name, body = "do it", parameters = emptyList(), revision = 1L)

	private fun routine(id: String, name: String) = Routine(
		id = id,
		name = name,
		weekdays = listOf(1L),
		weekInterval = 1L,
		startDate = "2026-01-05",
		time = "09:00",
		zone = "America/Los_Angeles",
		runbookId = "book",
		approvedRevision = 1L,
		values = kotlinx.serialization.json.JsonObject(emptyMap()),
		target = RoutineTarget(spawn = "host"),
		linkedEntries = emptyList(),
		enabled = true,
		revision = 1L,
		since = 0L,
	)

	private val state = ChatState(
		runbooks = listOf(
			GatewayRunbooks("sakura", listOf(book("shared", "Here"))),
			GatewayRunbooks("mikan", listOf(book("shared", "There"), book("only-there", "Only there"))),
		),
		routines = listOf(
			GatewayRoutines("sakura", listOf(RoutineState(routine("triage", "Here"), nextAt = 900L)), "America/Los_Angeles"),
			GatewayRoutines("mikan", listOf(RoutineState(routine("triage", "There"), nextAt = 300L)), "Europe/London"),
		),
	)

	@Test
	fun oneIdOnTwoGatewaysReadsAsTwoRecords() {
		assertEquals("Here", state.runbookOn("sakura", "shared")?.name)
		assertEquals("There", state.runbookOn("mikan", "shared")?.name)
		assertEquals("Here", state.routineOn("sakura", "triage")?.routine?.name)
		assertEquals("There", state.routineOn("mikan", "triage")?.routine?.name)
	}

	@Test
	fun aRecordOnAnotherGatewayIsNotFoundUnderThisOne() {
		assertEquals(null, state.runbookOn("sakura", "only-there"))
		assertEquals(null, state.routineOn("sakura", "nothing"))
		// An unknown gateway answers nothing rather than whatever happens to be first.
		assertEquals(emptyList<Runbook>(), state.runbooksOn("unknown"))
		assertEquals(emptyList<RoutineState>(), state.routinesOn("unknown"))
	}

	@Test
	fun aRoutinePicksFromItsOwnGatewaysLibrary() {
		// What the editor offers, so a routine cannot pin words another machine holds.
		assertEquals(listOf("Here"), state.runbooksOn("sakura").map { it.name })
		assertEquals(listOf("There", "Only there"), state.runbooksOn("mikan").map { it.name })
	}

	@Test
	fun thePhoneWakesForTheSoonestRunOnAnyGateway() {
		assertEquals(300L, state.soonestRoutineAt())
		// Nothing scheduled anywhere leaves the wake to whatever else asks for one.
		assertEquals(null, ChatState().soonestRoutineAt())
	}
}
