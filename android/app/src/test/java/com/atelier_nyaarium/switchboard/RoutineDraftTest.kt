package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.routines.ROUTINE_TARGET_ASSISTANT
import com.atelier_nyaarium.switchboard.routines.ROUTINE_TARGET_SPAWN
import com.atelier_nyaarium.switchboard.routines.RoutineDraft
import com.atelier_nyaarium.switchboard.routines.assistantSpawnOn
import com.atelier_nyaarium.switchboard.routines.routineTargetLine
import com.atelier_nyaarium.switchboard.routines.routineTargetMenu
import com.atelier_nyaarium.switchboard.runbooks.SpawnChoice
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineDraftTest {
	private fun routine(target: RoutineTarget, linkedEntries: List<String> = emptyList()) = Routine(
		id = "triage",
		name = "Morning triage",
		weekdays = listOf(1L),
		weekInterval = 1L,
		startDate = "2026-09-07",
		time = "09:00",
		zone = "UTC",
		runbookId = "book",
		approvedRevision = 1L,
		values = JsonObject(emptyMap()),
		target = target,
		linkedEntries = linkedEntries,
		forgetAfterDays = 7L,
		enabled = true,
		revision = 1L,
		since = 0L,
	)

	@Test
	fun aLegacyTargetRoundTripsAndIsSentAsSpawn() {
		val legacy = routine(RoutineTarget(spawn = "host", workdir = "~/notes"))
		val draft = RoutineDraft.of(legacy)
		val sent = draft.toRoutine()

		assertEquals(ROUTINE_TARGET_SPAWN, draft.targetKind)
		assertEquals("~/notes", draft.workdir)
		assertEquals(ROUTINE_TARGET_SPAWN, sent?.target?.kind)
		val reopened = RoutineDraft.of(requireNotNull(sent))
		assertEquals(ROUTINE_TARGET_SPAWN, reopened.targetKind)
		assertEquals("host", reopened.spawn)
	}

	@Test
	fun selectingAssistantDropsSpawnOnlyFieldsAndSendsAssistantKind() {
		val draft = RoutineDraft.of(
			routine(RoutineTarget(spawn = "host", workdir = "~/notes"), linkedEntries = listOf("deploy")),
		)
		val checkIn = draft.selectAssistant("host")
		val sent = checkIn.copy(workdir = "~/notes", linkedEntries = listOf("deploy")).toRoutine()

		assertEquals(ROUTINE_TARGET_ASSISTANT, checkIn.targetKind)
		assertEquals("", checkIn.workdir)
		assertTrue(checkIn.linkedEntries.isEmpty())
		assertEquals(ROUTINE_TARGET_ASSISTANT, sent?.target?.kind)
		assertNull(sent?.target?.workdir)
		assertTrue(sent?.linkedEntries.orEmpty().isEmpty())
		assertNull(checkIn.copy(spawn = "", forgetAfterDays = -1).refusal())
	}

	@Test
	fun theMenuOffersAssistantOnlyWhereAPlacedGatewayKeepsCheckInsAndKeepsAStalePickMarked() {
		val registry = testRegistry("sakura", "mikan", "yuzu")
		val state = ChatState(
			gateways = registry.copy(
				gateways = registry.gateways.map { entry ->
					entry.copy(
						assistant = AssistantWord.Answered(
							ConsoleAssistantStateResult(
								workdir = "~/notes".takeIf { entry.id != "mikan" },
								team = "host.assistant".takeIf { entry.id != "mikan" },
								watchers = emptyList(),
								// yuzu is placed but predates check-ins.
								checkIns = true.takeIf { entry.id == "sakura" },
							),
						),
					)
				},
			),
		)
		val spawns = listOf(SpawnChoice("host", "Host"), SpawnChoice("windows", "Windows"))
		val assistantSpawn = assistantSpawnOn(state, "sakura")
		val placed = routineTargetMenu(spawns, ROUTINE_TARGET_SPAWN, "host", assistantSpawn)
		val absent = routineTargetMenu(spawns, ROUTINE_TARGET_SPAWN, "host", assistantSpawnOn(state, "mikan"))
		val held = routineTargetMenu(emptyList(), ROUTINE_TARGET_ASSISTANT, "host", null)

		assertEquals("host", assistantSpawn)
		assertNull(assistantSpawnOn(state, "mikan"))
		assertNull(assistantSpawnOn(state, "yuzu"))
		assertEquals(listOf("Assistant", "Host", "Windows"), placed.map { it.label })
		assertTrue(absent.none { it.kind == ROUTINE_TARGET_ASSISTANT })
		// An unplaced check-in with no spawns known can still move to its own spawn.
		assertEquals(
			listOf(ROUTINE_TARGET_ASSISTANT to false, ROUTINE_TARGET_SPAWN to false),
			held.map { it.kind to it.offered },
		)
		assertTrue(held.all { it.spawn == "host" })
	}

	@Test
	fun aCheckInRowNamesAssistantAndASpawnRowAddsNothing() {
		assertEquals("Assistant", routineTargetLine(routine(RoutineTarget(kind = ROUTINE_TARGET_ASSISTANT, spawn = "host"))))
		assertNull(routineTargetLine(routine(RoutineTarget(spawn = "host"))))
	}
}
