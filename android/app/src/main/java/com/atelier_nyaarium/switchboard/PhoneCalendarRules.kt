package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PhoneCalendarEvent
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

internal data class CalendarRow(
	val id: String,
	val title: String,
	val start: Instant,
	val end: Instant,
	val allDay: Boolean,
	val location: String?,
	val calendar: String?,
)

internal fun calendarWindow(from: Instant?, days: Int?, now: Instant): Pair<Instant, Instant> {
	val start = from ?: now
	val span = (days ?: 7).coerceIn(1, 31)
	return start to start.plus(span.toLong(), ChronoUnit.DAYS)
}

internal fun daysUntil(start: Instant, allDay: Boolean, now: Instant, zone: ZoneId): Int {
	val today = now.atZone(zone).toLocalDate()
	val eventDay = if (allDay) start.atZone(ZoneOffset.UTC).toLocalDate() else start.atZone(zone).toLocalDate()
	return ChronoUnit.DAYS.between(today, eventDay).toInt()
}

internal fun matchesQuery(title: String, query: String?): Boolean {
	val needle = query?.trim().orEmpty()
	if (needle.length > 80) return false
	return needle.isEmpty() || title.contains(needle, ignoreCase = true)
}

internal fun selectEvents(rows: Sequence<CalendarRow>, query: String?, limit: Int?): List<CalendarRow> {
	val cap = (limit ?: 20).coerceIn(1, 50)
	return rows.filter { matchesQuery(it.title, query) }.take(cap).toList()
}

internal fun eventOf(row: CalendarRow, now: Instant, zone: ZoneId): PhoneCalendarEvent {
	val start = if (row.allDay) {
		row.start.atZone(ZoneOffset.UTC).toLocalDate().toString()
	} else {
		row.start.atZone(zone).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
	}
	val end = if (row.allDay) {
		row.end.atZone(ZoneOffset.UTC).toLocalDate().toString()
	} else {
		row.end.atZone(zone).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
	}
	return PhoneCalendarEvent(
		id = row.id,
		title = row.title.take(200),
		start = start,
		end = end,
		allDay = row.allDay,
		daysUntil = daysUntil(row.start, row.allDay, now, zone).toLong(),
		location = row.location?.take(200),
		calendar = row.calendar?.take(80),
	)
}
