package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.CliPick
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.UNPICKED_WORD
import com.atelier_nyaarium.switchboard.routines.ROUTINE_TARGET_ASSISTANT
import com.atelier_nyaarium.switchboard.routines.ROUTINE_TARGET_SPAWN
import com.atelier_nyaarium.switchboard.routines.RoutineDraft
import com.atelier_nyaarium.switchboard.routines.assistantSpawnOn
import com.atelier_nyaarium.switchboard.routines.keptZoneOf
import com.atelier_nyaarium.switchboard.routines.routineTargetLine
import com.atelier_nyaarium.switchboard.routines.routineTargetMenu
import com.atelier_nyaarium.switchboard.routines.assistantAbsent
import com.atelier_nyaarium.switchboard.routines.targetTag
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
	fun aDefaultPickFollowsTheSpawnPointAndAStoredOrTappedOneStays() {
		val everyCli = SpawnHarnesses.Known(SessionHarness.entries.toSet())
		val copilotOnly = SpawnHarnesses.Known(setOf(SessionHarness.COPILOT))
		val fresh = RoutineDraft.fresh(java.time.ZoneId.of("UTC")).withDefaultPick(everyCli)
		val stored = RoutineDraft.of(routine(RoutineTarget(spawn = "host", cli = "claude")))
		// No stored pick takes the default.
		val older = RoutineDraft.of(routine(RoutineTarget(spawn = "host"))).withDefaultPick(everyCli)

		assertEquals(CliPick.Picked(SessionHarness.CLAUDE), fresh.cli)
		assertEquals(CliPick.Picked(SessionHarness.COPILOT), fresh.selectSpawn("windows", copilotOnly).cli)
		assertEquals(CliPick.Picked(SessionHarness.CLAUDE), stored.withDefaultPick(copilotOnly).selectSpawn("windows", copilotOnly).cli)
		assertEquals(CliPick.Picked(SessionHarness.CLAUDE), older.cli)
		assertEquals(CliPick.Picked(SessionHarness.COPILOT), older.selectSpawn("windows", copilotOnly).cli)
		val tapped = fresh.tapCli("opencode", everyCli)
		assertEquals(CliPick.Picked(SessionHarness.OPENCODE), tapped.selectSpawn("windows", copilotOnly).cli)
	}

	@Test
	fun noPickSavesOnlyWhereTheCliIsUnknownOrSingle() {
		val unpicked = RoutineDraft.of(routine(RoutineTarget(spawn = "host", cli = UNPICKED_WORD)))
		val twoKnown = SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE, SessionHarness.COPILOT))

		assertEquals(PICK_A_CLI, unpicked.refusal(twoKnown))
		assertNull(unpicked.toRoutine(twoKnown))
		assertNull(unpicked.refusal(SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE))))
		assertNull(unpicked.refusal(SpawnHarnesses.UNOPENED_CONTAINER))
		// Check-in needs no pick.
		assertNull(unpicked.selectAssistant("assistant").refusal(twoKnown))
	}

	@Test
	fun aClearedPickGoesAsUnpickedAndOnlyAnUnreadableHeldOneGoesAsNone() {
		val unopened = SpawnHarnesses.UNOPENED_CONTAINER
		val picked = RoutineDraft.of(routine(RoutineTarget(spawn = "app", cli = "claude")))
		val newer = RoutineDraft.of(routine(RoutineTarget(spawn = "app", cli = "newer-cli")))

		assertEquals("claude", picked.toRoutine(unopened)?.target?.cli)
		assertEquals(UNPICKED_WORD, picked.tapCli("claude", unopened).toRoutine(unopened)?.target?.cli)
		// None keeps the held word on the Gateway.
		assertNull(newer.toRoutine(unopened)?.target?.cli)
		assertEquals("newer-cli", newer.shownCli)
		assertEquals(UNPICKED_WORD, newer.tapCli("newer-cli", unopened).toRoutine(unopened)?.target?.cli)
		// A check-in runs no CLI of its own.
		assertEquals(UNPICKED_WORD, picked.selectAssistant("assistant").toRoutine()?.target?.cli)
	}

	@Test
	fun aSavedRoutineKeepsItsZoneAndANewOneTakesThePhones() {
		val tokyo = java.time.ZoneId.of("Asia/Tokyo")
		val held = routine(RoutineTarget(spawn = "host"))
		val monday = java.time.LocalDate.parse("2026-09-07")

		// Edited abroad, sent as stored.
		val shown = RoutineDraft.of(held).shown(tokyo.id, monday)
		assertEquals("18:00", shown.time)
		val sent = shown.asKept(keptZoneOf(held, tokyo), monday).toRoutine()
		assertEquals("UTC", sent?.zone)
		assertEquals("09:00", sent?.time)

		val fresh = RoutineDraft.fresh(tokyo)
		assertEquals(tokyo.id, fresh.asKept(keptZoneOf(null, tokyo), monday).zone)
	}

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
	fun theAssistantSpawnFollowsTheRouterRecord() {
		val record = AssistantHomeRecord(version = 2L, gatewayId = "sakura")
		val state = ChatState(assistantHome = AssistantHome.Read(record, AssistantHomeReport(2L, "sakura", "placed")))
		// Moving offers no check-in yet.
		assertNull(assistantSpawnOn(ChatState(assistantHome = AssistantHome.Read(record, null)), "sakura"))
		val spawns = listOf(SpawnChoice("host", "Host"), SpawnChoice("windows", "Windows"))
		val assistantSpawn = assistantSpawnOn(state, "sakura")
		val placed = routineTargetMenu(spawns, ROUTINE_TARGET_SPAWN, "host", assistantSpawn)
		val absent = routineTargetMenu(spawns, ROUTINE_TARGET_SPAWN, "host", assistantSpawnOn(state, "mikan"))
		val held = routineTargetMenu(emptyList(), ROUTINE_TARGET_ASSISTANT, "host", null)

		assertEquals("host", assistantSpawn)
		assertNull(assistantSpawnOn(state, "mikan"))
		assertEquals(listOf("Assistant", "Host", "Windows"), placed.map { it.label })
		assertTrue(absent.none { it.kind == ROUTINE_TARGET_ASSISTANT })
		assertEquals(
			listOf(ROUTINE_TARGET_ASSISTANT to false, ROUTINE_TARGET_SPAWN to false),
			held.map { it.kind to it.offered },
		)
		assertTrue(held.all { it.spawn == "host" })
		assertEquals(listOf(true, false), held.map(::assistantAbsent))
		assertNull(targetTag(placed.first()))
		assertTrue(targetTag(held.first()) != targetTag(held.last()))
	}

	@Test
	fun aCheckInRowNamesAssistantAndASpawnRowAddsNothing() {
		assertEquals("Assistant", routineTargetLine(routine(RoutineTarget(kind = ROUTINE_TARGET_ASSISTANT, spawn = "host"))))
		assertNull(routineTargetLine(routine(RoutineTarget(spawn = "host"))))
	}
}
