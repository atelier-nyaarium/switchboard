package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineAttention
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.routines.RoutineDraft
import com.atelier_nyaarium.switchboard.routines.attentionLine
import com.atelier_nyaarium.switchboard.routines.lastRunLine
import com.atelier_nyaarium.switchboard.routines.missLine
import com.atelier_nyaarium.switchboard.routines.nextRunLine
import com.atelier_nyaarium.switchboard.routines.ruleMoved
import com.atelier_nyaarium.switchboard.routines.runbookChipLabel
import com.atelier_nyaarium.switchboard.routines.scheduleLine
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineTextTest {
	private val utc = java.time.ZoneId.of("UTC")

	private fun routine(
		weekdays: List<Long> = listOf(1L),
		weekInterval: Long = 1L,
		time: String = "09:00",
		zone: String = "America/Los_Angeles",
		enabled: Boolean = true,
	) = Routine(
		id = "triage",
		name = "Morning triage",
		weekdays = weekdays,
		weekInterval = weekInterval,
		startDate = "2026-09-07",
		time = time,
		zone = zone,
		runbookId = "book",
		approvedRevision = 1L,
		values = JsonObject(emptyMap()),
		target = RoutineTarget(spawn = "host"),
		linkedEntries = emptyList(),
		enabled = enabled,
		revision = 1L,
		since = 0L,
	)

	@Test
	fun theScheduleReadsInTheZoneTheGatewayHoldsIt() {
		assertEquals("Mon at 09:00 America/Los_Angeles", scheduleLine(routine()))
		assertEquals(
			"every other week, Mon, Wed at 09:00 America/Los_Angeles",
			scheduleLine(routine(weekdays = listOf(3L, 1L), weekInterval = 2L)),
		)
		assertEquals(
			"every 4 weeks, Every day at 09:00 America/Los_Angeles",
			scheduleLine(routine(weekdays = (1L..7L).toList(), weekInterval = 4L)),
		)
	}

	@Test
	fun onlyTheNextRunIsConverted() {
		val at = java.time.Instant.parse("2026-09-14T09:00:00Z").toEpochMilli()
		assertTrue(nextRunLine(routine(), at, utc).startsWith("Next "))
		assertEquals("Disabled", nextRunLine(routine(enabled = false), at, utc))
		assertEquals("Nothing further scheduled", nextRunLine(routine(), null, utc))
	}

	@Test
	fun aRunSaysWhetherItWasPickedUpAndNeverWhetherItWentWell() {
		val at = java.time.Instant.parse("2026-09-14T09:00:00Z").toEpochMilli()
		val state = { read: Long? ->
			RoutineState(routine = routine(), lastRanAt = at, lastReadAt = read)
		}
		assertNull(lastRunLine(RoutineState(routine = routine()), utc))
		assertTrue(lastRunLine(state(null), utc)!!.endsWith("Its session never read it."))
		assertTrue(lastRunLine(state(at + 1_000), utc)!!.endsWith("and it was read."))
	}

	@Test
	fun aMissSaysTheGatewaysOwnStoryRatherThanOneThePhoneInvented() {
		val at = java.time.Instant.parse("2026-09-14T09:00:00Z").toEpochMilli()
		val miss = { reason: String -> RoutineMiss("triage:$at", at, reason, true) }
		assertTrue(missLine(miss("session_busy"), utc).endsWith("its session stayed busy."))
		assertTrue(missLine(miss("host_unreachable"), utc).endsWith("its machine could not be reached."))
		assertTrue(missLine(miss("gateway_down"), utc).endsWith("this Gateway was not running."))
	}

	@Test
	fun anUnansweredSecretNamesTheRunThatWantedIt() {
		val at = java.time.Instant.parse("2026-09-14T09:00:00Z").toEpochMilli()
		val line = attentionLine(RoutineAttention("triage:$at", at, listOf("deploy", "npm")), utc)
		assertTrue(line.contains("deploy, npm"))
	}

	@Test
	fun twoRunbooksSharingANameAreToldApartByTheirIds() {
		val names = listOf("Release", "Release", "Triage")
		assertEquals("Release (a)", runbookChipLabel("Release", "a", names))
		assertEquals("Release (b)", runbookChipLabel("Release", "b", names))
		assertEquals("Triage", runbookChipLabel("Triage", "c", names))
	}

	@Test
	fun aDraftRefusesAnIdThatCouldNotNameItsSession() {
		val ok = RoutineDraft(id = "triage", name = "T", startDate = "2026-09-07", zone = "UTC", runbookId = "b", approvedRevision = 1L)
		assertNull(ok.refusal())
		assertNotNull(ok.copy(id = "Morning Triage").refusal())
		assertNotNull(ok.copy(id = "a".repeat(57)).refusal())
		assertNotNull(ok.copy(time = "9:00").refusal())
		assertNotNull(ok.copy(weekdays = emptySet()).refusal())
		assertNotNull(ok.copy(runbookId = "").refusal())
	}

	@Test
	fun onlyAMovedWallClockRuleAsksTheOwnerToConfirm() {
		val held = routine()
		val draft = RoutineDraft.of(held)
		assertFalse(ruleMoved(held, draft))
		assertFalse(ruleMoved(held, draft.copy(name = "Other")))
		assertTrue(ruleMoved(held, draft.copy(time = "10:00")))
		assertTrue(ruleMoved(held, draft.copy(zone = "UTC")))
		assertTrue(ruleMoved(held, draft.copy(weekdays = setOf(2))))
		assertTrue(ruleMoved(held, draft.copy(weekInterval = 2)))
		// Nothing was stored, so nothing moved.
		assertFalse(ruleMoved(null, draft.copy(time = "10:00")))
	}

	@Test
	fun theOwnerEditsTheirOwnTimeAndTheGatewayKeepsIts() {
		// Monday 09:00 in Los Angeles is the small hours of Tuesday in Tokyo. Which hour depends on
		// daylight saving, so the weekday moving is what this pins rather than the clock face.
		val la = routine(weekdays = listOf(1L), time = "09:00", zone = "America/Los_Angeles")
		val shown = RoutineDraft.of(la).shown("Asia/Tokyo")
		assertEquals(setOf(2), shown.weekdays)
		assertEquals("Asia/Tokyo", shown.zone)
		// The start date goes with the week, or a fortnightly rule keeps the wrong parity.
		assertEquals("2026-09-08", shown.startDate)

		// Back again is what a save sends, and it is the rule the gateway already held.
		val kept = shown.asKept("America/Los_Angeles")
		assertEquals("09:00", kept.time)
		assertEquals(setOf(1), kept.weekdays)
		assertEquals("2026-09-07", kept.startDate)
		assertEquals("America/Los_Angeles", kept.zone)
	}

	@Test
	fun everyDayOfTheWeekSurvivesTheTrip() {
		val la = routine(weekdays = (1L..7L).toList(), time = "23:30", zone = "America/Los_Angeles")
		val shown = RoutineDraft.of(la).shown("Asia/Tokyo")
		// Seven days go over and seven come back; a per-day conversion could fold two onto one.
		assertEquals(7, shown.weekdays.size)
		assertEquals(setOf(1, 2, 3, 4, 5, 6, 7), shown.asKept("America/Los_Angeles").weekdays)
	}

	@Test
	fun anUntouchedRuleReadAbroadIsNotAMove() {
		val la = routine(weekdays = listOf(1L), time = "09:00", zone = "America/Los_Angeles")
		// What the editor holds while the owner is in Tokyo and has changed nothing.
		val shown = RoutineDraft.of(la).shown("Asia/Tokyo")
		assertFalse(ruleMoved(la, shown))
		assertTrue(ruleMoved(la, shown.copy(time = "10:00")))
	}

	@Test
	fun aZoneNeitherSideKnowsLeavesTheRuleAlone() {
		val la = routine(weekdays = listOf(1L), time = "09:00", zone = "America/Los_Angeles")
		val draft = RoutineDraft.of(la)
		// Better an unconverted rule the gateway then refuses than a silently mangled one.
		assertEquals(draft.time, draft.shown("Mars/Olympus").time)
		assertEquals(draft.weekdays, draft.shown("Mars/Olympus").weekdays)
	}

	@Test
	fun aDraftRefusesWhatTheGatewaysSchemaWouldRatherThanBlameTheNetwork() {
		val ok = RoutineDraft(id = "triage", name = "T", startDate = "2026-09-07", zone = "UTC", runbookId = "b", approvedRevision = 1L)
		assertNotNull(ok.copy(weekInterval = 0).refusal())
		assertNotNull(ok.copy(weekInterval = 9).refusal())
		assertNotNull(ok.copy(startDate = "07/09/2026").refusal())
		assertNotNull(ok.copy(spawn = "").refusal())
		assertNotNull(ok.copy(linkedEntries = List(17) { "e$it" }).refusal())
		assertNotNull(ok.copy(linkedEntries = listOf("a", "a")).refusal())
	}

	@Test
	fun aDraftCarriesTheRevisionItWasOpenedAtAndNeverMintsOne() {
		val held = routine()
		val draft = RoutineDraft.of(held).copy(name = "Renamed")
		val sent = draft.toRoutine()
		assertNotNull(sent)
		assertEquals(1L, draft.revision)
		assertEquals(0L, sent?.since)
	}
}
