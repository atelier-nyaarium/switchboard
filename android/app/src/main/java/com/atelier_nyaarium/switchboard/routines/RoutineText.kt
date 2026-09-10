package com.atelier_nyaarium.switchboard.routines

import com.atelier_nyaarium.switchboard.absoluteTimeText
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineAttention
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineState

private val WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

/**
 * The rule as the gateway holds it, in the zone it holds it in. Nothing here converts: the phone
 * would otherwise show a schedule that reads differently in every airport, for a rule that did not
 * move. Only the next run is ever converted, and `nextRunLine` is what does it.
 */
internal fun scheduleLine(routine: Routine): String {
	val days = routine.weekdays.sorted().mapNotNull { WEEKDAYS.getOrNull(it.toInt() - 1) }
	val named = when {
		days.isEmpty() -> "No day"
		days.size == 7 -> "Every day"
		else -> days.joinToString(", ")
	}
	val every = when (routine.weekInterval) {
		1L -> ""
		2L -> "every other week, "
		else -> "every ${routine.weekInterval} weeks, "
	}
	return "$every$named at ${routine.time} ${routine.zone}"
}

/** The one instant the phone converts, because the owner needs to know when it actually lands. */
internal fun nextRunLine(routine: Routine, nextAt: Long?, zone: java.time.ZoneId): String = when {
	!routine.enabled -> "Disabled"
	nextAt == null -> "Nothing further scheduled"
	else -> "Next ${absoluteTimeText(nextAt, zone)}"
}

/**
 * What became of the last run. Never whether the work was any good, which this Gateway cannot know:
 * only whether the session it was handed to ever read what it was asked.
 */
internal fun lastRunLine(row: RoutineState, zone: java.time.ZoneId): String? {
	val ran = row.lastRanAt ?: return null
	val at = absoluteTimeText(ran, zone)
	return if (row.lastReadAt == null) "Ran $at. Its session never read it." else "Ran $at, and it was read."
}

/** What a miss says. The reason is the gateway's word for it; the phone does not classify. */
internal fun missLine(miss: RoutineMiss, zone: java.time.ZoneId): String {
	val story = when (miss.reason) {
		"session_busy" -> "its session stayed busy"
		"host_unreachable" -> "its machine could not be reached"
		"disabled" -> "it was turned off"
		else -> "this Gateway was not running"
	}
	return "Did not run at ${absoluteTimeText(miss.scheduledAt, zone)}: $story."
}

internal fun reviewLine(reviewAt: Long, zone: java.time.ZoneId): String =
	"Stopped at ${absoluteTimeText(reviewAt, zone)}: its runbook changed. Open it to approve the new words."

/** Only a new request can use a link, so this run cannot be given the secret afterwards. */
internal fun attentionLine(attention: RoutineAttention, zone: java.time.ZoneId): String {
	val secrets = attention.entryIds.joinToString(", ")
	return "The run at ${absoluteTimeText(attention.scheduledAt, zone)} asked for $secrets and got no answer. " +
		"That run is over, so linking serves the next one."
}

/**
 * Names are not unique; ids are. Two runbooks called the same thing are one choice the owner cannot
 * tell apart, and picking the wrong one pins a routine to words they never read.
 */
internal fun runbookChipLabel(name: String, id: String, names: List<String>): String =
	if (names.count { it == name } > 1) "$name ($id)" else name

/** A run already handed to its session is not recalled by any of the three. */
internal const val VERBS_EXPLAIN = "A run already handed over carries on either way."

/** What each verb touches, before the tap. */
internal const val DISMISS_EXPLAINS = "Settles this one run. The schedule keeps going."
internal const val DELETE_EXPLAINS = "Removes the routine, its runs and its linked secrets."
