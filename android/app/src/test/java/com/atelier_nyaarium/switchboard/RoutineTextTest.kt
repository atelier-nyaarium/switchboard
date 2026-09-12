package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineAttention
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import com.atelier_nyaarium.switchboard.routines.RoutineDraft
import com.atelier_nyaarium.switchboard.routines.attentionLine
import com.atelier_nyaarium.switchboard.routines.clockOf
import com.atelier_nyaarium.switchboard.routines.clockText
import com.atelier_nyaarium.switchboard.routines.grantedAfter
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.routines.lastRunLine
import com.atelier_nyaarium.switchboard.routines.matchesSecret
import com.atelier_nyaarium.switchboard.routines.missLine
import com.atelier_nyaarium.switchboard.routines.nextRunLine
import com.atelier_nyaarium.switchboard.routines.ruleMoved
import com.atelier_nyaarium.switchboard.routines.runbookChipLabel
import com.atelier_nyaarium.switchboard.routines.runbookMenu
import com.atelier_nyaarium.switchboard.routines.scheduleLine
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
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

	private fun book(id: String, revision: Long, vararg parameters: RunbookParameter) =
		Runbook(id = id, name = id, body = "x", parameters = parameters.toList(), revision = revision)

	@Test
	fun pickingAnotherRunbookRetiresTheOldAnswersAndSeedsTheNewDefaults() {
		val apt = book("apt", 3L, RunbookParameter(name = "scope", label = "Scope", kind = "choice", default = "full", options = listOf("full", "security")))
		val backup = book("backup", 5L, RunbookParameter(name = "scope", label = "Scope", kind = "text"))
		val draft = RoutineDraft.of(routine()).pickRunbook(apt).copy(values = mapOf("scope" to "security"))

		val same = draft.pickRunbook(apt)
		assertEquals(mapOf("scope" to "security"), same.values)

		// Same id at a newer revision is new words, so the answers go too.
		val revised = draft.pickRunbook(apt.copy(revision = 4L))
		assertEquals(4L, revised.approvedRevision)
		assertEquals(mapOf("scope" to "full"), revised.values)

		val moved = draft.pickRunbook(backup)
		assertEquals("backup", moved.runbookId)
		assertEquals(5L, moved.approvedRevision)
		assertEquals(mapOf("scope" to ""), moved.values)
	}

	// The gateway prefixes the session name, so an id carrying it reads as routine-routine-xxxx.
	@Test
	fun aFreshRoutineIdCarriesNoSessionPrefix() {
		val fresh = RoutineDraft.fresh(java.time.ZoneId.of("America/Los_Angeles"))
		assertFalse(fresh.id, fresh.id.startsWith("routine-"))
		assertEquals("America/Los_Angeles", fresh.zone)
		assertNull(fresh.copy(name = "T", runbookId = "b", approvedRevision = 1L).refusal())
	}

	@Test
	fun theClockReadsAnHhMmAndFallsBackToNineSharp() {
		assertEquals(9 to 30, clockOf("09:30"))
		assertEquals(23 to 59, clockOf("23:59"))
		assertEquals(9 to 0, clockOf("25:00"))
		assertEquals(9 to 0, clockOf("09:60"))
		assertEquals(9 to 0, clockOf(""))
		assertEquals("07:05", clockText(7, 5))
	}

	@Test
	fun aHeldRunbookTheLibraryNoLongerHoldsStaysPickableFirstAndMarked() {
		val library = listOf(book("apt", 3L))
		assertEquals(library, runbookMenu(library, "apt", 3L))
		assertEquals(library, runbookMenu(library, "", 0L))
		val menu = runbookMenu(library, "gone", 9L)
		assertEquals(listOf("gone", "apt"), menu.map { it.id })
		assertEquals(9L, menu.first().revision)
	}

	private fun entry(id: String, title: String, description: String? = null) = VaultEntryView(
		id = id,
		revision = 1L,
		createdBy = "phone",
		createdAt = 0L,
		updatedAt = 0L,
		publicTitle = title,
		publicDescription = description,
		privateTitle = null,
		privateDescription = null,
		gateways = null,
		gatewaysUnreadable = false,
		hasValue = true,
	)

	@Test
	fun theGrantedLineNamesWholeEntriesThenCountsTheRestAndTheGhosts() {
		val vault = listOf(entry("a", "Sakura Nyaarium"), entry("b", "Arbiter Root"), entry("c", "GitHub PAT"))
		assertEquals("None granted.", grantedLine(emptyList(), vault))
		assertEquals("Sakura Nyaarium, Arbiter Root", grantedLine(listOf("a", "b"), vault))
		assertEquals("Sakura Nyaarium, 1 no longer in the vault", grantedLine(listOf("a", "gone"), vault))

		val many = (1..12).map { entry("e$it", "Entry number $it") }
		val line = grantedLine(many.map { it.id }, many)
		assertTrue(line, line.endsWith(" more"))
		assertFalse(line, line.contains("Entry number 12"))
	}

	@Test
	fun theFilterReadsTitleAndDescriptionWithoutCase() {
		val pat = entry("c", "GitHub PAT", "Repo and workflow token")
		assertTrue(matchesSecret(pat, ""))
		assertTrue(matchesSecret(pat, "github"))
		assertTrue(matchesSecret(pat, "TOKEN"))
		assertFalse(matchesSecret(pat, "kubernetes"))
	}

	@Test
	fun doneKeepsHeldOrderAppendsNewPicksInVaultOrderAndDropsGhosts() {
		val vault = listOf(entry("a", "A"), entry("b", "B"), entry("c", "C"))
		val after = grantedAfter(previous = listOf("c", "ghost", "a"), chosen = setOf("c", "ghost", "a", "b"), entries = vault)
		assertEquals(listOf("c", "a", "b"), after)
		assertEquals(listOf("a"), grantedAfter(listOf("c", "a"), setOf("a"), vault))
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
	fun aRuleReadOutAndBackComesHomeUnchangedInEveryWeekOfTheYear() {
		val la = routine(weekdays = listOf(1L), time = "09:00", zone = "America/Los_Angeles")
		val draft = RoutineDraft.of(la)
		// Every Monday of 2026, so the weeks either side of both hemispheres' clock changes are in.
		var day = java.time.LocalDate.parse("2026-01-05")
		while (day.year == 2026) {
			val shown = draft.shown("Asia/Tokyo", day)
			val kept = shown.asKept("America/Los_Angeles", day)
			assertEquals("$day", draft.time, kept.time)
			assertEquals("$day", draft.weekdays, kept.weekdays)
			assertEquals("$day", draft.startDate, kept.startDate)
			assertFalse("$day", ruleMoved(la, shown, day))
			day = day.plusWeeks(1)
		}
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
