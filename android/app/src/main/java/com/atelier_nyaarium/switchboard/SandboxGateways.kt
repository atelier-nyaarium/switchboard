package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import com.atelier_nyaarium.switchboard.proto.PolicyBinding
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineRunResult
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
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry
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

/** Differ per Gateway; a mutation stays. */
internal class SandboxPolicyGateway : PolicyGateway {
	private fun policy(id: String, name: String, entryId: String, keys: List<String>, enabled: Boolean = true) =
		AuthorizationPolicy(
			id = id,
			name = name,
			binding = PolicyBinding(entryId = entryId),
			selectorKeys = keys,
			enabled = enabled,
			revision = 2L,
		)

	private val shelves = mutableMapOf(
		EMPTY_GATEWAY to emptyList(),
		SECOND_GATEWAY to listOf(policy("apt", "Package administration", "deploy-key", listOf("sudo apt"))),
	)

	private fun shelf(gatewayId: String) = shelves.getOrPut(gatewayId) {
		listOf(
			policy("apt", "Package administration", "deploy-key", listOf("sudo apt", "sudo systemctl")),
			policy("docker", "Container restarts", "elsewhere-key", listOf("sudo docker"), enabled = false),
			policy(REFUSING_ID, "Held elsewhere", "deploy-key", listOf("sudo held")),
		)
	}

	/** A record that moved after the phone read it, until a save over it lands. */
	private val movedTo = mutableMapOf(REFUSING_ID to 9L)

	private fun store(gatewayId: String, stored: AuthorizationPolicy): ConsolePolicyPutResult {
		val held = shelf(gatewayId)
		shelves[gatewayId] = if (held.any { it.id == stored.id }) held.map { if (it.id == stored.id) stored else it } else held + stored
		movedTo.remove(stored.id)
		return ConsolePolicyPutResult(stored = true, revision = stored.revision, policy = stored)
	}

	override suspend fun list(gatewayId: String) = PolicyListAnswer.Listed(shelf(gatewayId))

	/** A base off the held revision is refused with it. */
	private fun stale(gatewayId: String, policyId: String, baseRevision: Long?): ConsolePolicyPutResult? {
		val held = shelf(gatewayId).firstOrNull { it.id == policyId }
		val holds = movedTo[policyId] ?: held?.revision
		if (holds == null || holds == baseRevision) return null
		return ConsolePolicyPutResult(stored = false, revision = holds, reason = "revision $holds is stored; this edits ${baseRevision ?: "nothing"}")
	}

	override suspend fun put(gatewayId: String, policy: AuthorizationPolicy, baseRevision: Long?) = when {
		policy.id != "apt" && "sudo apt" in policy.selectorKeys ->
			ConsolePolicyPutResult(stored = false, revision = baseRevision ?: 0L, reason = "sudo apt is already answered by Package administration")
		else -> stale(gatewayId, policy.id, baseRevision) ?: store(gatewayId, policy.copy(revision = (baseRevision ?: 0L) + 1))
	}

	override suspend fun delete(gatewayId: String, policyId: String, baseRevision: Long): ConsolePolicyDeleteResult {
		stale(gatewayId, policyId, baseRevision)?.let { return ConsolePolicyDeleteResult(deleted = false, reason = it.reason) }
		shelves[gatewayId] = shelf(gatewayId).filterNot { it.id == policyId }
		return ConsolePolicyDeleteResult(deleted = true)
	}

	override suspend fun enable(gatewayId: String, policyId: String, enabled: Boolean, baseRevision: Long): ConsolePolicyPutResult {
		stale(gatewayId, policyId, baseRevision)?.let { return it }
		val held = shelf(gatewayId).firstOrNull { it.id == policyId }
			?: return ConsolePolicyPutResult(stored = false, revision = 0L, reason = "no policy with that id is stored")
		return store(gatewayId, held.copy(enabled = enabled, revision = baseRevision + 1))
	}
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

	/** Refuses, so the row's reason is reachable. */
	override suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean, baseRevision: Long) =
		if (routineId == REFUSING_ID) {
			ConsoleRoutinePutResult(stored = false, revision = 9L, reason = "revision 9 is stored; this edits $baseRevision")
		} else {
			ConsoleRoutinePutResult(stored = true, revision = baseRevision + 1, routine = routine(routineId, routineId, enabled = enabled))
		}

	override suspend fun runNow(gatewayId: String, routineId: String, occurrenceId: String) =
		ConsoleRoutineOccurrenceResult(applied = true)

	override suspend fun run(gatewayId: String, routineId: String) =
		ConsoleRoutineRunResult(ran = true, occurrenceId = System.currentTimeMillis().toString())

	override suspend fun dismiss(gatewayId: String, routineId: String, occurrenceId: String) =
		ConsoleRoutineOccurrenceResult(applied = true)
}

/**
 * A small canned workspace, so the tree, the outline, a symbol's detail and a window all draw without
 * a session to reach. The second seeded session refuses everything, which is the only way the
 * refusal notice is reachable here.
 */
internal class SandboxWorkspaceGateway : WorkspaceGateway {
	private val file = listOf(
		"import { z } from \"zod\";",
		"",
		"/** What a routine may remember, in UTF-8 BYTES. */",
		"export const MAX_ROUTINE_MEMORY_BYTES = 32_768;",
		"",
		"/** Why a routine cannot be stored, or null. */",
		"export function routineRefusal(routine: Routine): string | null {",
		"\tif (routine.weekdays.length === 0) return \"a routine with no weekday would never fire\";",
		"\tif (!knownZone(routine.zone)) return `\${routine.zone} is not a zone`;",
		"\treturn null;",
		"}",
	)

	private val module = "src/shared/schemasRoutine.ts"

	private fun idOf(name: String) = "lexicon typescript $module $name."

	/**
	 * Keyed by the SESSION, not its Gateway, since that is what a workspace belongs to. One session
	 * refuses so the refusal notice is reachable, and the empty Gateway answers an empty workspace,
	 * which is not the same as one that could not be read.
	 */
	private fun <T> asSeeded(target: WorkspaceTarget, empty: () -> T, answer: () -> T): WorkspaceAnswer<T> =
		when {
			target.address.endsWith(".other") -> WorkspaceAnswer.Refused("this workspace is not served here")
			target.gatewayId == EMPTY_GATEWAY -> WorkspaceAnswer.Read(empty())
			else -> WorkspaceAnswer.Read(answer())
		}

	override suspend fun tree(target: WorkspaceTarget, path: String) =
		asSeeded(target, { WorkspaceTreeAnswer(path = path, truncated = false, entries = emptyList()) }) {
			WorkspaceTreeAnswer(
				path = path,
				truncated = false,
				entries = when (path) {
					"" -> listOf(
						WorkspaceTreeEntry(name = "src", directory = true, children = 2),
						WorkspaceTreeEntry(name = "AGENTS.md", directory = false, bytes = 18_402),
					)
					"src" -> listOf(WorkspaceTreeEntry(name = "shared", directory = true, children = 1))
					else -> listOf(WorkspaceTreeEntry(name = "schemasRoutine.ts", directory = false, bytes = 9_431))
				},
			)
		}

	override suspend fun file(target: WorkspaceTarget, path: String) =
		asSeeded(target, { WorkspaceReadAnswer(path = path, text = "", lines = 0) }) {
			WorkspaceReadAnswer(path = path, text = file.joinToString("\n"), lines = file.size.toLong())
		}

	override suspend fun outline(target: WorkspaceTarget, path: String) =
		asSeeded(target, { WorkspaceOutlineAnswer(path = path, symbols = emptyList()) }) {
			WorkspaceOutlineAnswer(
				path = path,
				symbols = listOf(
					WorkspaceOutlineSymbol(
						symbolId = idOf("MAX_ROUTINE_MEMORY_BYTES"),
						name = "MAX_ROUTINE_MEMORY_BYTES",
						symbolKind = "const",
						signature = "= 32_768",
						startLine = 4,
					),
					WorkspaceOutlineSymbol(
						symbolId = idOf("routineRefusal()"),
						name = "routineRefusal",
						symbolKind = "function",
						signature = "(routine: Routine): string | null",
						startLine = 7,
					),
				),
			)
		}

	override suspend fun symbolSource(target: WorkspaceTarget, symbolId: String) =
		asSeeded(target, { blankSpan(symbolId) }) {
			val wholeFunction = symbolId.contains("routineRefusal")
			val start = if (wholeFunction) 6 else 3
			val end = if (wholeFunction) 11 else 4
			WorkspaceSymbolSourceAnswer(
				symbolId = symbolId,
				module = module,
				name = if (wholeFunction) "routineRefusal" else "MAX_ROUTINE_MEMORY_BYTES",
				text = file.subList(start - 1, end).joinToString("\n"),
				startLine = start.toLong(),
				endLine = end.toLong(),
				spanHash = "sandbox-${start}-$end",
			)
		}

	override suspend fun knowledge(target: WorkspaceTarget, symbolId: String) =
		asSeeded(target, { WorkspaceKnowledgeAnswer(symbolId = symbolId, text = "") }) {
			WorkspaceKnowledgeAnswer(
				symbolId = symbolId,
				text = "Describe: returns the reason a routine cannot be stored, or null when it can.\n\n" +
					"Why: a rule that parses can still name nothing, so the refusal asks the recurrence " +
					"calculator rather than trusting the parse.",
			)
		}

	private fun blankSpan(symbolId: String) =
		WorkspaceSymbolSourceAnswer(
			symbolId = symbolId,
			module = module,
			name = "nothing",
			text = "",
			startLine = 1,
			endLine = 1,
			spanHash = "sandbox-empty",
		)
}
