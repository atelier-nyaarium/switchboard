package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineAttention
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.routines.RoutineDraft
import com.atelier_nyaarium.switchboard.routines.attentionLine
import com.atelier_nyaarium.switchboard.routines.missLine
import com.atelier_nyaarium.switchboard.routines.nextRunLine
import com.atelier_nyaarium.switchboard.routines.ruleMoved
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
	fun aMissSaysTheGatewaysOwnStoryRatherThanOneThePhoneInvented() {
		val at = java.time.Instant.parse("2026-09-14T09:00:00Z").toEpochMilli()
		val miss = { reason: String -> RoutineMiss("triage:$at", at, reason, true) }
		assertTrue(missLine(miss("session_busy"), utc).endsWith("its session stayed busy"))
		assertTrue(missLine(miss("host_unreachable"), utc).endsWith("its machine could not be reached"))
		assertTrue(missLine(miss("gateway_down"), utc).endsWith("this Gateway was not running"))
	}

	@Test
	fun anUnansweredSecretNamesTheRunThatWantedIt() {
		val at = java.time.Instant.parse("2026-09-14T09:00:00Z").toEpochMilli()
		val line = attentionLine(RoutineAttention("triage:$at", at, listOf("deploy", "npm")), utc)
		assertTrue(line.contains("deploy, npm"))
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
		// Nothing was stored, so nothing moved.
		assertFalse(ruleMoved(null, draft.copy(time = "10:00")))
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
