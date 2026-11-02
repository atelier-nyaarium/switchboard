package com.atelier_nyaarium.switchboard

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneCalendarRulesTest {
	private val zone = ZoneId.of("America/Los_Angeles")

	@Test
	fun defaultsWindowToSevenDaysFromNow() {
		val now = Instant.parse("2025-03-08T12:00:00Z")

		assertEquals(now to now.plusSeconds(7 * 24 * 60 * 60L), calendarWindow(null, null, now))
	}

	@Test
	fun boundsWindowDays() {
		val now = Instant.parse("2025-03-08T12:00:00Z")

		assertEquals(now.plusSeconds(24 * 60 * 60L), calendarWindow(null, 0, now).second)
		assertEquals(now.plusSeconds(31 * 24 * 60 * 60L), calendarWindow(null, 50, now).second)
	}

	@Test
	fun countsAllDayDatesAndTimedLocalDays() {
		val early = Instant.parse("2025-06-09T07:01:00Z")
		val late = Instant.parse("2025-06-10T06:00:00Z")
		val tomorrow = LocalDate.of(2025, 6, 10).atStartOfDay(ZoneOffset.UTC).toInstant()
		val laterToday = LocalDate.of(2025, 6, 9).atTime(23, 30).atZone(zone).toInstant()

		assertEquals(1, daysUntil(tomorrow, true, early, zone))
		assertEquals(1, daysUntil(tomorrow, true, late, zone))
		assertEquals(0, daysUntil(laterToday, false, late, zone))
	}

	@Test
	fun filtersCaseInsensitivelyAndKeepsTheBoundedOrder() {
		val first = row("1", "Planning")
		val second = row("2", "Planning notes")
		val third = row("3", "Work")

		assertTrue(matchesQuery("Planning", " plan "))
		assertTrue(matchesQuery("Planning", "  "))
		assertFalse(matchesQuery("Planning", "travel"))
		assertFalse(matchesQuery("Planning", "p".repeat(81)))
		assertEquals(listOf(first, second), selectEvents(sequenceOf(first, second, third), "PLAN", 2))
		assertEquals(listOf(first), selectEvents(sequenceOf(first, second, third), "plan", 1))
	}

	@Test
	fun theCapEndsTheRead() {
		var read = 0
		val rows = generateSequence { read += 1; row(read.toString(), "Planning") }

		assertEquals(3, selectEvents(rows, null, 3).size)
		assertEquals(3, read)
	}

	@Test
	fun aSelectiveQueryStopsReadingAtTheScanCap() {
		var read = 0
		val rows = generateSequence { read += 1; row(read.toString(), "Work") }

		assertEquals(emptyList<CalendarRow>(), selectEvents(rows, "plan", 5))
		assertEquals(CALENDAR_SCAN_CAP, read)
	}

	@Test
	fun formatsAllDayDatesAndTimedOffsets() {
		val now = Instant.parse("2025-06-09T19:00:00Z")
		val allDay = row(
			id = "all-day",
			title = "Planning",
			start = LocalDate.of(2025, 6, 10).atStartOfDay(ZoneOffset.UTC).toInstant(),
			end = LocalDate.of(2025, 6, 11).atStartOfDay(ZoneOffset.UTC).toInstant(),
			allDay = true,
		)
		val timed = row(
			id = "timed",
			title = "Planning",
			start = Instant.parse("2025-06-09T23:00:17Z"),
			end = Instant.parse("2025-06-10T00:00:00Z"),
		)

		assertEquals("2025-06-10", eventOf(allDay, now, zone).start)
		assertEquals("2025-06-11", eventOf(allDay, now, zone).end)
		assertEquals("2025-06-09T16:00:17-07:00", eventOf(timed, now, zone).start)
	}

	private fun row(
		id: String,
		title: String,
		start: Instant = Instant.parse("2025-06-09T23:00:00Z"),
		end: Instant = Instant.parse("2025-06-10T00:00:00Z"),
		allDay: Boolean = false,
	) = CalendarRow(id, title, start, end, allDay, null, null)
}
