package com.atelier_nyaarium.switchboard.routines

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The slug a routine's id has to be, because its reserved session is named from it. */
private val ID_RE = Regex("^[a-z0-9][a-z0-9-]*$")
private const val MAX_ID_LEN = 56
private val TIME_RE = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")

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
	fun refusal(): String? = when {
		!ID_RE.matches(id) || id.length > MAX_ID_LEN -> "The id must be lowercase letters, digits and dashes"
		name.isBlank() -> "Give it a name"
		weekdays.isEmpty() -> "Pick at least one day"
		!TIME_RE.matches(time) -> "The time reads as HH:MM"
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
 * asked about: the editor shows their own zone, the gateway keeps its own, and occurrences already
 * made keep the instants they were made with.
 */
internal fun ruleMoved(held: Routine?, draft: RoutineDraft): Boolean = held != null &&
	(held.time != draft.time || held.zone != draft.zone || held.weekdays.map { it.toInt() }.toSet() != draft.weekdays)
