package com.atelier_nyaarium.switchboard.routines

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The slug a routine's id has to be, because its reserved session is named from it. */
private val ID_RE = Regex("^[a-z0-9][a-z0-9-]*$")
private const val MAX_ID_LEN = 56
private val TIME_RE = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")
private val DATE_RE = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

/** What the record's own schema bounds, mirrored so a refusal is not read as a dead network. */
private const val MAX_WEEK_INTERVAL = 8
private const val MAX_LINKED = 16

/**
 * What the editor holds. The gateway owns the revision and when it took the routine, so neither is
 * edited here and neither is sent as anything but what was read.
 */
internal data class RoutineDraft(
	val id: String,
	val name: String = "",
	val weekdays: Set<Int> = setOf(1),
	val weekInterval: Int = 1,
	val startDate: String,
	val time: String = "09:00",
	val zone: String,
	val runbookId: String = "",
	val approvedRevision: Long = 0L,
	val values: Map<String, String> = emptyMap(),
	val spawn: String = "host",
	val workdir: String = "",
	val linkedEntries: List<String> = emptyList(),
	val enabled: Boolean = true,
	/** What was read, so a save says which record it edits. Zero means nothing was stored. */
	val revision: Long = 0L,
) {
	/**
	 * Every rule the gateway's schema would refuse, checked here too. Without it a schema refusal
	 * comes back as a thrown parse and the screen blames the network for the owner's own typo.
	 */
	fun refusal(): String? = when {
		!ID_RE.matches(id) || id.length > MAX_ID_LEN -> "The id must be lowercase letters, digits and dashes"
		name.isBlank() -> "Give it a name"
		weekdays.isEmpty() -> "Pick at least one day"
		weekInterval !in 1..MAX_WEEK_INTERVAL -> "Every N weeks reads 1 to $MAX_WEEK_INTERVAL"
		!TIME_RE.matches(time) -> "The time reads as HH:MM"
		!DATE_RE.matches(startDate) -> "The start date reads as YYYY-MM-DD"
		spawn.isBlank() -> "Name a spawn point"
		linkedEntries.size > MAX_LINKED -> "At most $MAX_LINKED secrets"
		linkedEntries.size != linkedEntries.toSet().size -> "A secret is linked twice"
		runbookId.isBlank() -> "Pick a runbook"
		approvedRevision <= 0L -> "Pick a runbook"
		else -> null
	}

	fun toRoutine(): Routine? {
		if (refusal() != null) return null
		return Routine(
			id = id,
			name = name.trim(),
			weekdays = weekdays.sorted().map { it.toLong() },
			weekInterval = weekInterval.toLong(),
			startDate = startDate,
			time = time,
			zone = zone,
			runbookId = runbookId,
			approvedRevision = approvedRevision,
			values = JsonObject(values.mapValues { (_, value) -> JsonPrimitive(value) }),
			target = RoutineTarget(spawn = spawn, workdir = workdir.ifBlank { null }),
			linkedEntries = linkedEntries,
			enabled = enabled,
			// Named by the gateway, whatever is sent.
			revision = revision.coerceAtLeast(1L),
			since = 0L,
		)
	}

	/** The same rule read in another zone, for showing the owner their own time. */
	fun shown(inZoneId: String, on: java.time.LocalDate = today()): RoutineDraft = read(inZoneId, on)

	/** The same rule as the gateway keeps it, which is what a save sends. */
	fun asKept(gatewayZone: String, on: java.time.LocalDate = today()): RoutineDraft = read(gatewayZone, on)

	/** A flip writes at once only while nothing else is edited. */
	fun flipsAtOnce(held: Routine?, inZoneId: String): Boolean = held != null && this == of(held).shown(inZoneId)

	private fun read(target: String, on: java.time.LocalDate): RoutineDraft {
		if (target == zone) return this
		val moved = inZone(weekdays, time, zone, target, on)
		return copy(
			weekdays = moved.weekdays,
			time = moved.time,
			startDate = shiftDate(startDate, moved.days),
			zone = target,
		)
	}

	companion object {
		fun of(routine: Routine): RoutineDraft = RoutineDraft(
			id = routine.id,
			name = routine.name,
			weekdays = routine.weekdays.map { it.toInt() }.toSet(),
			weekInterval = routine.weekInterval.toInt(),
			startDate = routine.startDate,
			time = routine.time,
			zone = routine.zone,
			runbookId = routine.runbookId,
			approvedRevision = routine.approvedRevision,
			// Decoded rather than printed: `toString` would keep the quotes and the escapes.
			values = routine.values.mapValues { (_, value) -> (value as? JsonPrimitive)?.content.orEmpty() },
			spawn = routine.target.spawn,
			workdir = routine.target.workdir.orEmpty(),
			linkedEntries = routine.linkedEntries,
			enabled = routine.enabled,
			revision = routine.revision,
		)
	}
}

/**
 * Whether saving this draft moves the wall-clock rule, which is the one change the owner has to be
 * asked about: occurrences already made keep the instants they were made with.
 *
 * Both sides are read as the gateway keeps them. Comparing the owner's clock face against the
 * gateway's would call every save abroad a move, including one that changed nothing.
 */
internal fun ruleMoved(held: Routine?, draft: RoutineDraft, on: java.time.LocalDate = today()): Boolean {
	if (held == null) return false
	val sending = draft.asKept(held.zone, on)
	return held.time != sending.time ||
		held.zone != sending.zone ||
		held.startDate != sending.startDate ||
		held.weekInterval.toInt() != sending.weekInterval ||
		held.weekdays.map { it.toInt() }.toSet() != sending.weekdays
}

/** A rule read in another zone: the clock face, and how far the whole week moved with it. */
internal data class ZoneRead(val weekdays: Set<Int>, val time: String, val days: Int)

/** The week both directions anchor on, in UTC so neither zone's own date picks a different one. */
internal fun today(): java.time.LocalDate = java.time.LocalDate.now(java.time.ZoneOffset.UTC)

/**
 * The same instant read in another zone: the weekday and the time together, because converting the
 * time alone lands a Monday evening in Tokyo on a Monday morning in Los Angeles rather than Sunday.
 *
 * There is no zone picker. The owner edits in their own zone and the gateway's is canonical, so this
 * is the one road between them.
 *
 * One shift for the whole rule, not one per day. A wall clock has no per-day answer, and converting
 * each day on its own lets a daylight-saving week fold two of them onto one and lose an occurrence.
 *
 * `on` is read in UTC so both directions anchor on one calendar week. Reading it in each zone's own
 * today lets the two directions land in different weeks, and a rule converted out and back comes
 * home an hour off across a daylight-saving boundary.
 */
internal fun inZone(
	weekdays: Set<Int>,
	time: String,
	from: String,
	to: String,
	on: java.time.LocalDate = java.time.LocalDate.now(java.time.ZoneOffset.UTC),
): ZoneRead {
	val unchanged = ZoneRead(weekdays, time, 0)
	val at = runCatching {
		val (hour, minute) = time.split(":").map { it.toInt() }
		java.time.LocalTime.of(hour, minute)
	}.getOrNull() ?: return unchanged
	val source = runCatching { java.time.ZoneId.of(from) }.getOrNull() ?: return unchanged
	val target = runCatching { java.time.ZoneId.of(to) }.getOrNull() ?: return unchanged

	val anchor = on.minusDays((on.dayOfWeek.value - 1).toLong())
	val there = anchor.atTime(at).atZone(source).withZoneSameInstant(target)
	val days = java.time.temporal.ChronoUnit.DAYS.between(anchor, there.toLocalDate()).toInt()
	val moved = weekdays.map { day -> ((day - 1 + days) % 7 + 7) % 7 + 1 }.toSet()
	return ZoneRead(moved, "%02d:%02d".format(there.hour, there.minute), days)
}

/** Carried with the rule, or a fortnightly one keeps a parity its weekday no longer matches. */
private fun shiftDate(date: String, days: Int): String {
	if (days == 0) return date
	return runCatching { java.time.LocalDate.parse(date).plusDays(days.toLong()).toString() }.getOrDefault(date)
}
