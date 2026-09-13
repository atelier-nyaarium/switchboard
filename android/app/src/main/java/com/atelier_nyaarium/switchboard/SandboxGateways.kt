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
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileDestination
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
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

private const val READ_ONLY_FILE = "fixtures.json"
private const val UNHASHED_FILE = "capture.bin"

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

/** A canned workspace, so every workspace screen draws with no session to reach. */
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
	 * Keyed by SESSION, which is what a workspace belongs to. One of the two seeded sessions refuses,
	 * so the refusal notice is reachable; the empty Gateway holds no session to ask.
	 */
	private fun <T> asSeeded(target: WorkspaceTarget, answer: () -> T): WorkspaceAnswer<T> =
		if (target.address.endsWith(".other")) {
			WorkspaceAnswer.Refused("this workspace is not served here")
		} else {
			WorkspaceAnswer.Read(answer())
		}

	/** Fixed. `src/generated` stays empty for its notice. */
	private val folders = listOf("src", "src/generated", "src/shared")

	/** Mutable, so a change shows in the tree. */
	private val files = java.util.concurrent.ConcurrentHashMap(
		listOf("AGENTS.md", READ_ONLY_FILE, UNHASHED_FILE, module).associateWith { file.joinToString("\n") },
	)

	private val identities = java.util.concurrent.ConcurrentHashMap<String, String>()

	private val minted = java.util.concurrent.atomic.AtomicLong(0)

	private fun identityOf(path: String) = identities.getOrPut(path) { "sandbox-inode-${minted.incrementAndGet()}" }

	private fun hashOf(text: String) = "sandbox-${text.hashCode()}"

	private fun parentOf(path: String) = path.substringBeforeLast('/', "")

	/** Too large to edit, and too large to hash. */
	private fun bytesOf(path: String) =
		when (path) {
			READ_ONLY_FILE -> 912_000L
			UNHASHED_FILE -> 300_000_000L
			else -> files[path]?.toByteArray()?.size?.toLong()
		}

	override suspend fun tree(target: WorkspaceTarget, path: String) =
		asSeeded(target) {
			val childFolders = folders.filter { parentOf(it) == path }
			val childFiles = files.keys.filter { parentOf(it) == path }.sorted()
			WorkspaceTreeAnswer(
				path = path,
				truncated = false,
				entries = childFolders.map { folder ->
					val children = folders.count { parentOf(it) == folder } + files.keys.count { parentOf(it) == folder }
					WorkspaceTreeEntry(name = folder.substringAfterLast('/'), directory = true, children = children.toLong())
				} + childFiles.map {
					WorkspaceTreeEntry(name = it.substringAfterLast('/'), directory = false, bytes = bytesOf(it))
				},
			)
		}

	override suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> {
		val held = asSeeded(target) { files[path] }
		if (held !is WorkspaceAnswer.Read) return WorkspaceAnswer.Refused("this workspace is not served here")
		val text = held.value ?: return WorkspaceAnswer.Refused("$path does not exist")
		if (path == UNHASHED_FILE) return WorkspaceAnswer.Refused("$path is too large to read")
		val lines = text.split("\n").size.toLong()
		return WorkspaceAnswer.Read(
			if (path == READ_ONLY_FILE) {
				WorkspaceReadAnswer(path = path, text = text, lines = lines, readOnly = "$path is over the editing limit")
			} else {
				WorkspaceReadAnswer(path = path, text = text, lines = lines, hash = hashOf(text))
			},
		)
	}

	private fun withheld(path: String) = path.substringAfterLast('/').let { it.startsWith(".env") && it != ".env.example" }

	override suspend fun fileState(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceFileStateAnswer> {
		if (withheld(path)) return WorkspaceAnswer.Refused("$path is withheld")
		return asSeeded(target) {
			val text = files[path]
			when {
				path.isEmpty() || path in folders -> WorkspaceFileStateAnswer(path = path, state = "directory")
				text == null -> WorkspaceFileStateAnswer(path = path, state = "absent")
				path == UNHASHED_FILE -> WorkspaceFileStateAnswer(path = path, state = "file", bytes = bytesOf(path))
				else -> WorkspaceFileStateAnswer(
					path = path,
					state = "file",
					bytes = bytesOf(path),
					hash = hashOf(text),
					identity = identityOf(path),
				)
			}
		}
	}

	/** Whether `path` is still the file a precondition named. */
	private fun holds(path: String, hash: String, identity: String?) =
		files[path]?.let { hashOf(it) == hash } == true && (identity == null || identityOf(path) == identity)

	private fun landsOn(destination: WorkspaceFileDestination, to: String) =
		when (destination) {
			WorkspaceFileDestination.Absent -> !files.containsKey(to)
			is WorkspaceFileDestination.Replace -> holds(to, destination.expectedHash, destination.expectedIdentity)
		}

	/** Refused as the plugin refuses, never answered as changed. */
	private fun placeRefusal(path: String): String? =
		when {
			withheld(path) -> "$path is withheld"
			path in folders -> "$path is a folder"
			parentOf(path).let { it.isNotEmpty() && it !in folders } -> "${parentOf(path)} is not a folder here"
			else -> null
		}

	/** AGENTS.md always reads as moved on a write. Every other precondition is checked, as the plugin checks it. */
	override suspend fun mutateFile(
		target: WorkspaceTarget,
		mutation: WorkspaceFileMutation,
	): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		val place = when (mutation) {
			is WorkspaceFileMutation.Create -> mutation.path
			is WorkspaceFileMutation.Move -> mutation.to
			is WorkspaceFileMutation.Copy -> mutation.to
			else -> null
		}
		place?.let(::placeRefusal)?.let { return WorkspaceAnswer.Refused(it) }
		return asSeeded(target) {
			val answer = { path: String, outcome: String -> WorkspaceFileMutationAnswer(path = path, outcome = outcome) }
			when (mutation) {
				is WorkspaceFileMutation.Write ->
					if (mutation.path == "AGENTS.md") {
						files[mutation.path] = "# Agents\n\nChanged by the agent."
						answer(mutation.path, MUTATION_STALE)
					} else if (!holds(mutation.path, mutation.expectedHash, null)) {
						answer(mutation.path, MUTATION_STALE)
					} else {
						files[mutation.path] = mutation.text
						WorkspaceFileMutationAnswer(path = mutation.path, outcome = MUTATION_DONE, hash = hashOf(mutation.text))
					}
				is WorkspaceFileMutation.Create ->
					if (files.putIfAbsent(mutation.path, mutation.text) != null) {
						answer(mutation.path, MUTATION_DESTINATION_CHANGED)
					} else {
						WorkspaceFileMutationAnswer(path = mutation.path, outcome = MUTATION_DONE, hash = hashOf(mutation.text))
					}
				is WorkspaceFileMutation.Delete ->
					if (!holds(mutation.path, mutation.expectedHash, mutation.expectedIdentity)) {
						answer(mutation.path, MUTATION_STALE)
					} else {
						files.remove(mutation.path)
						identities.remove(mutation.path)
						answer(mutation.path, MUTATION_DONE)
					}
				is WorkspaceFileMutation.Move -> when {
					!holds(mutation.path, mutation.expectedHash, mutation.expectedIdentity) -> answer(mutation.path, MUTATION_STALE)
					!landsOn(mutation.destination, mutation.to) -> answer(mutation.path, MUTATION_DESTINATION_CHANGED)
					else -> {
						files[mutation.to] = files.remove(mutation.path) ?: ""
						identities[mutation.to] = identityOf(mutation.path)
						identities.remove(mutation.path)
						WorkspaceFileMutationAnswer(path = mutation.path, outcome = MUTATION_DONE, hash = mutation.expectedHash)
					}
				}
				is WorkspaceFileMutation.Copy -> when {
					!holds(mutation.path, mutation.expectedHash, null) -> answer(mutation.path, MUTATION_STALE)
					!landsOn(mutation.destination, mutation.to) -> answer(mutation.path, MUTATION_DESTINATION_CHANGED)
					else -> {
						files[mutation.to] = files[mutation.path] ?: ""
						identities.remove(mutation.to)
						WorkspaceFileMutationAnswer(path = mutation.path, outcome = MUTATION_DONE, hash = mutation.expectedHash)
					}
				}
			}
		}
	}

	override suspend fun outline(target: WorkspaceTarget, path: String) =
		asSeeded(target) {
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
		asSeeded(target) {
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
		asSeeded(target) {
			WorkspaceKnowledgeAnswer(
				symbolId = symbolId,
				text = "Describe: returns the reason a routine cannot be stored, or null when it can.\n\n" +
					"Why: a rule that parses can still name nothing, so the refusal asks the recurrence " +
					"calculator rather than trusting the parse.",
			)
		}

	/** One saves and one is stale, so both are reachable. */
	override suspend fun saveSpan(
		target: WorkspaceTarget,
		symbolId: String,
		expectedSpanHash: String,
		text: String,
	): WorkspaceAnswer<WorkspaceSaveSpanAnswer> {
		val seeded = (symbolSource(target, symbolId) as? WorkspaceAnswer.Read)?.value
			?: return WorkspaceAnswer.Refused("this workspace is not served here")
		return asSeeded(target) {
			if (symbolId.contains("routineRefusal")) {
				WorkspaceSaveSpanAnswer(
					symbolId = symbolId,
					outcome = SAVE_SAVED,
					current = seeded.copy(text = text, spanHash = "sandbox-saved-${text.hashCode()}"),
					joined = false,
				)
			} else {
				WorkspaceSaveSpanAnswer(
					symbolId = symbolId,
					outcome = SAVE_STALE,
					current = seeded.copy(text = "export const MAX_ROUTINE_MEMORY_BYTES = 65_536;", spanHash = "sandbox-moved"),
				)
			}
		}
	}
}
