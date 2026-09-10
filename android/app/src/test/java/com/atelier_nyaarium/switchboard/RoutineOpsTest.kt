package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineRunResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

private fun routine(id: String, name: String = id) = Routine(
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

class RoutineOpsTest {
	/** Answers per gateway, and holds a list until the test releases it. */
	private class FakeGateway : RoutineGateway {
		val shelves = mutableMapOf<String, List<RoutineState>>()
		val zones = mutableMapOf<String, String>()
		val held = mutableMapOf<String, CompletableDeferred<Unit>>()
		val asked = mutableListOf<String>()
		val ranOn = mutableListOf<String>()
		val unreachable = mutableSetOf<String>()

		override suspend fun list(gatewayId: String): ConsoleRoutineListResult {
			asked += gatewayId
			held[gatewayId]?.await()
			if (gatewayId in unreachable) throw IllegalStateException("unreachable")
			return ConsoleRoutineListResult(
				routines = shelves[gatewayId].orEmpty(),
				zone = zones[gatewayId] ?: "UTC",
			)
		}

		override suspend fun put(gatewayId: String, routine: Routine, baseRevision: Long?) =
			ConsoleRoutinePutResult(stored = true, revision = 1L, routine = routine)

		override suspend fun next(gatewayId: String, routine: Routine) = ConsoleRoutineNextResult(nextAt = null)

		override suspend fun delete(gatewayId: String, routineId: String) =
			ConsoleRoutineDeleteResult(deleted = true)

		val refuseToggles = mutableSetOf<String>()

		override suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean, baseRevision: Long) =
			if (routineId in refuseToggles) {
				ConsoleRoutinePutResult(stored = false, revision = baseRevision + 1, reason = "revision ${baseRevision + 1} is stored; this edits $baseRevision")
			} else {
				ConsoleRoutinePutResult(stored = true, revision = baseRevision + 1, routine = routine(routineId).copy(enabled = enabled, revision = baseRevision + 1))
			}

		override suspend fun runNow(gatewayId: String, routineId: String, occurrenceId: String) =
			ConsoleRoutineOccurrenceResult(applied = true)

		override suspend fun run(gatewayId: String, routineId: String): ConsoleRoutineRunResult {
			ranOn += gatewayId
			return ConsoleRoutineRunResult(ran = true, occurrenceId = "1")
		}

		override suspend fun dismiss(gatewayId: String, routineId: String, occurrenceId: String) =
			ConsoleRoutineOccurrenceResult(applied = true)
	}

	private class Host(override val gateway: RoutineGateway?) : RoutineHost

	private fun ChatState.on(gatewayId: String) = gateways.entry(gatewayId)

	/** Drawn Gateway answers. */
	private fun ChatState.drawn() = gateways.gateways.filter { it.routines != null }.map { it.id }

	/** Roster controls drawn groups. */
	private fun admitting(vararg gatewayIds: String) =
		MutableStateFlow(ChatState(gateways = testRegistry(*gatewayIds)))

	@Test
	fun everyAdmittedGatewayIsDrawnRatherThanOneOfThem() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("triage")))
		fake.shelves["mikan"] = listOf(RoutineState(routine("triage", name = "Elsewhere")))
		fake.zones["sakura"] = "America/Los_Angeles"
		fake.zones["mikan"] = "Europe/London"
		val state = admitting("sakura", "mikan")
		val ops = RoutineOps(state, Host(fake))

		runBlocking { ops.refreshAll() }

		assertEquals(listOf("mikan", "sakura"), state.value.drawn())
		// Each gateway's own zone, since a schedule read against another's is a wrong time on screen.
		assertEquals("America/Los_Angeles", state.value.on("sakura")?.routineZone)
		assertEquals("Europe/London", state.value.on("mikan")?.routineZone)
		assertEquals("Elsewhere", state.value.on("mikan")?.routines?.single()?.routine?.name)
	}

	@Test
	fun aGatewayThatCannotBeReachedLeavesTheOthersDrawn() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("triage")))
		fake.unreachable += "mikan"
		val state = admitting("sakura", "mikan")
		val ops = RoutineOps(state, Host(fake))

		runBlocking { ops.refreshAll() }

		assertEquals(listOf("sakura"), state.value.drawn())
	}

	@Test
	fun aSlowAnswerFromOneGatewayDoesNotDiscardAFreshAnswerFromAnother() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("slow")))
		fake.shelves["mikan"] = listOf(RoutineState(routine("quick")))
		val gate = CompletableDeferred<Unit>()
		fake.held["sakura"] = gate
		val state = admitting("sakura", "mikan")
		val ops = RoutineOps(state, Host(fake))

		val slow = async { ops.refresh("sakura") }
		ops.refresh("mikan")
		gate.complete(Unit)
		slow.await()

		// One counter per gateway, so the held read still lands under its own id.
		assertEquals("slow", state.value.on("sakura")?.routines?.single()?.routine?.id)
		assertEquals("quick", state.value.on("mikan")?.routines?.single()?.routine?.id)
	}

	@Test
	fun aStaleReadOfOneGatewayDoesNotOverwriteANewerOne() = runBlocking {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("old")))
		val gate = CompletableDeferred<Unit>()
		fake.held["sakura"] = gate
		val state = admitting("sakura")
		val ops = RoutineOps(state, Host(fake))

		val stale = async { ops.refresh("sakura") }
		fake.held.remove("sakura")
		fake.shelves["sakura"] = listOf(RoutineState(routine("new")))
		ops.refresh("sakura")
		gate.complete(Unit)
		stale.await()

		assertEquals("new", state.value.on("sakura")?.routines?.single()?.routine?.id)
	}

	@Test
	fun aGatewayTheKeyringNoLongerAdmitsStopsBeingDrawn() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("triage")))
		fake.shelves["mikan"] = listOf(RoutineState(routine("triage")))
		val state = admitting("sakura", "mikan")
		val ops = RoutineOps(state, Host(fake))

		runBlocking { ops.refreshAll() }
		state.value = state.value.copy(gateways = testRegistry("sakura"))
		runBlocking { ops.refreshAll() }

		// Revoked, so its rows go rather than lingering as something the owner can still act on.
		assertEquals(listOf("sakura"), state.value.drawn())
	}

	@Test
	fun aPassThatStartedBeforeAGatewayWasAdmittedDoesNotDropIt() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("triage")))
		fake.shelves["mikan"] = listOf(RoutineState(routine("triage")))
		val state = admitting("sakura")
		val ops = RoutineOps(state, Host(fake))

		runBlocking {
			// A second Gateway is admitted and drawn while this pass is still running.
			val gate = CompletableDeferred<Unit>()
			fake.held["sakura"] = gate
			val old = async { ops.refreshAll() }
			state.value = state.value.copy(gateways = testRegistry("sakura", "mikan"))
			ops.refresh("mikan")
			gate.complete(Unit)
			old.await()
		}

		assertEquals(listOf("mikan", "sakura"), state.value.drawn())
	}

	@Test
	fun aPressedRunGoesToTheGatewayTheRowCameFrom() {
		val fake = FakeGateway()
		fake.shelves["mikan"] = listOf(RoutineState(routine("triage")))
		val state = admitting("sakura", "mikan")
		val ops = RoutineOps(state, Host(fake))

		assertEquals(true, runBlocking { ops.run("triage", "mikan") })
		assertEquals(listOf("mikan"), fake.ranOn)
	}

	@Test
	fun aRefusedToggleSaysWhyOnTheRowUntilOneLands() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(RoutineState(routine("triage")))
		fake.refuseToggles += "triage"
		val state = admitting("sakura")
		val ops = RoutineOps(state, Host(fake))

		val refused = runBlocking { ops.setEnabled("triage", false, 1L, "sakura") }
		assertEquals(true, refused is RoutineSaved.Refused)
		assertEquals("revision 2 is stored; this edits 1", ops.toggleRefusalFor("sakura", "triage"))
		// The gateway's own state is what the row draws after a refusal.
		assertEquals(true, state.value.on("sakura")?.routines?.single()?.routine?.enabled)

		fake.refuseToggles -= "triage"
		assertEquals(true, runBlocking { ops.setEnabled("triage", false, 1L, "sakura") } is RoutineSaved.Stored)
		assertEquals(null, ops.toggleRefusalFor("sakura", "triage"))
	}

	@Test
	fun anEditOnOneGatewayIsNotTheEditOnAnotherOfTheSameId() {
		val ops = RoutineOps(MutableStateFlow(ChatState()), Host(null))
		val here = routine("triage", name = "Here")
		val there = routine("triage", name = "There")

		ops.keepDraft("sakura", "triage", here)
		ops.keepDraft("mikan", "triage", there)
		assertEquals(here, ops.draftFor("sakura", "triage"))
		assertEquals(there, ops.draftFor("mikan", "triage"))

		// A new routine shares the key "new" on every gateway, and must not share the draft.
		ops.keepDraft("sakura", "new", here)
		ops.keepDraft("mikan", "new", there)
		assertEquals(here, ops.draftFor("sakura", "new"))

		ops.dropDraft("sakura", "new")
		assertEquals(there, ops.draftFor("mikan", "new"))
	}
}
