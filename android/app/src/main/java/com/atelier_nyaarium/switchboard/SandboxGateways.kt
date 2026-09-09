package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineAttention
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import kotlinx.serialization.json.JsonObject

// What a Gateway would answer, answered in the sandbox instead. Every screen that only appears when
// a Gateway refuses had never been rendered by anything, because `isSandbox` closes the network and
// a screen waiting on an answer waits forever. These are ports, not sockets: nothing here opens one,
// so the residue test that reads every network door stays true.

/** Deliberately not a wire word: the residue fence reads this file for those. */
private const val REFUSING_ID = "held-elsewhere"

/** Each answers differently, or a grouping bug has nowhere to show. */
private const val SECOND_GATEWAY = "parsing"

private const val EMPTY_GATEWAY = "idle-box"

private fun day(offsetMs: Long): Long = System.currentTimeMillis() + offsetMs

/**
 * The next Monday or Wednesday at 09:00 in the zone the canned routines name, so the schedule line
 * and the next run agree. Two lines that disagree are the first thing a reader would call a bug.
 */
private fun nextSlot(weeksOut: Long = 0L): Long {
	val zone = java.time.ZoneId.of("America/Los_Angeles")
	var at = java.time.ZonedDateTime.now(zone).withHour(9).withMinute(0).withSecond(0).withNano(0)
	while (at.dayOfWeek.value != 1 && at.dayOfWeek.value != 3) at = at.plusDays(1)
	if (at.toInstant().toEpochMilli() <= System.currentTimeMillis()) at = at.plusDays(1)
	while (at.dayOfWeek.value != 1 && at.dayOfWeek.value != 3) at = at.plusDays(1)
	return at.plusWeeks(weeksOut).toInstant().toEpochMilli()
}

internal class SandboxRunbookGateway : RunbookGateway {
	override suspend fun list(gatewayId: String) = ConsoleRunbookListResult(
		runbooks = when (gatewayId) {
			EMPTY_GATEWAY -> emptyList()
			// The same id, a different record, so a mix-up is visible.
			SECOND_GATEWAY -> listOf(
				Runbook(
					id = "release",
					name = "Tag a build",
					body = "Tag {{repo}} and push it.",
					parameters = listOf(RunbookParameter(name = "repo", label = "Repo", kind = "text")),
					revision = 1L,
				),
			)
			else -> listOf(
				Runbook(
					id = "release",
					name = "Cut a release",
					body = "Cut a {{level}} release of {{repo}}.",
					parameters = listOf(
						RunbookParameter(name = "level", label = "Level", kind = "choice", options = listOf("patch", "minor")),
						RunbookParameter(name = "repo", label = "Repo", kind = "text"),
					),
					revision = 3L,
				),
				Runbook(
					id = REFUSING_ID,
					name = "Held elsewhere",
					body = "Saving this one is always refused, so the Overwrite offer can be seen.",
					parameters = emptyList(),
					revision = 9L,
				),
			)
		},
	)

	override suspend fun put(gatewayId: String, runbook: Runbook, baseRevision: Long?, overwrite: Boolean) =
		if (runbook.id == REFUSING_ID && !overwrite) {
			ConsoleRunbookPutResult(stored = false, revision = 9L, reason = "revision 9 is stored; this edits ${baseRevision ?: 0}")
		} else {
			ConsoleRunbookPutResult(stored = true, revision = runbook.revision + 1, runbook = runbook.copy(revision = runbook.revision + 1))
		}

	override suspend fun delete(gatewayId: String, runbookId: String) = ConsoleRunbookDeleteResult(deleted = true)

	override suspend fun preview(gatewayId: String, runbookId: String, values: Map<String, String>) =
		ConsoleRunbookPreviewResult(text = values.entries.joinToString(" ") { "${it.key}=${it.value}" }, revision = 3L)

	override suspend fun fire(
		gatewayId: String,
		runbookId: String,
		values: Map<String, String>,
		into: RunbookFireTarget,
		previewedRevision: Long?,
	) = ConsoleRunbookFireResult(fired = true)
}

internal class SandboxRoutineGateway : RoutineGateway {
	private fun routine(id: String, name: String, enabled: Boolean = true, zone: String = "America/Los_Angeles") = Routine(
		id = id,
		name = name,
		weekdays = listOf(1L, 3L),
		weekInterval = 1L,
		startDate = "2026-09-07",
		time = "09:00",
		zone = zone,
		runbookId = "release",
		approvedRevision = 3L,
		values = JsonObject(emptyMap()),
		target = RoutineTarget(spawn = "host"),
		linkedEntries = emptyList(),
		enabled = enabled,
		revision = 2L,
		since = day(-30L * 86_400_000L),
	)

	/** One of each panel, so no line in the tab is unreachable. */
	override suspend fun list(gatewayId: String) = when (gatewayId) {
		EMPTY_GATEWAY -> ConsoleRoutineListResult(zone = "America/Los_Angeles", routines = emptyList())
		// Its own zone, and the same id as another Gateway's routine.
		SECOND_GATEWAY -> ConsoleRoutineListResult(
			zone = "Europe/London",
			routines = listOf(
				RoutineState(
					routine = routine("triage", "Parser sweep", zone = "Europe/London"),
					nextAt = nextSlot(),
				),
			),
		)
		else -> ConsoleRoutineListResult(
			zone = "America/Los_Angeles",
			routines = listOf(
				RoutineState(
					routine = routine("triage", "Morning triage"),
					nextAt = nextSlot(),
					lastRanAt = day(-86_400_000L),
				),
				RoutineState(
					routine = routine("sweep", "Weekly sweep"),
					nextAt = nextSlot(1L),
					missed = RoutineMiss(
						occurrenceId = "sweep:1",
						scheduledAt = day(-2 * 86_400_000L),
						reason = "session_busy",
						runnable = true,
					),
				),
				RoutineState(
					routine = routine("deploy", "Nightly deploy", enabled = false),
					reviewAt = day(-5 * 86_400_000L),
					attention = RoutineAttention(
						occurrenceId = "deploy:1",
						scheduledAt = day(-5 * 86_400_000L),
						entryIds = listOf("deploy-key"),
					),
				),
			),
		)
	}

	override suspend fun put(gatewayId: String, routine: Routine, baseRevision: Long?) =
		if (routine.id == REFUSING_ID) {
			ConsoleRoutinePutResult(stored = false, revision = 9L, reason = "revision 9 is stored; this edits ${baseRevision ?: 0}")
		} else {
			ConsoleRoutinePutResult(stored = true, revision = 3L, routine = routine.copy(revision = 3L))
		}

	override suspend fun next(gatewayId: String, routine: Routine) = ConsoleRoutineNextResult(nextAt = nextSlot())

	override suspend fun delete(gatewayId: String, routineId: String) = ConsoleRoutineDeleteResult(deleted = true)

	override suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean) =
		ConsoleRoutinePutResult(stored = true, revision = 3L)

	override suspend fun runNow(gatewayId: String, routineId: String, occurrenceId: String) =
		ConsoleRoutineOccurrenceResult(applied = true)

	override suspend fun dismiss(gatewayId: String, routineId: String, occurrenceId: String) =
		ConsoleRoutineOccurrenceResult(applied = true)
}
