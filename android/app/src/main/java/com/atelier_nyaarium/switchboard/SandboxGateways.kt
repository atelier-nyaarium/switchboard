package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.sha256Hex
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineRunResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.PolicyBinding
import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineAttention
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeEntry
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeFacts
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspacePaintTextAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import kotlinx.coroutines.delay
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

/** Holds more symbol kinds than one row of chips fits. */
private const val MANY_KINDS_FILE = "src/shared/schemasWorkspace.ts"

/** A real session answers later, or a screen racing its own read passes here. */
private const val WORKSPACE_ROUND_TRIP_MS = 400L

internal const val SANDBOX_ROOT = "~/projects/sandbox"

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

private const val SANDBOX_MODULE = "src/shared/schemasRoutine.ts"

/** A canned reply to a windows ask. */
internal fun sandboxWindowsReply(text: String, now: Long): Message? {
	if (!text.startsWith(WINDOWS_ASK_LEAD)) return null
	val keys = listOf("routineRefusal()" to (7L to 11L), "MAX_ROUTINE_MEMORY_BYTES" to (4L to 4L)).map { (name, lines) ->
		RefKeyMeta(
			key = "$SANDBOX_MODULE:$name",
			startLine = lines.first,
			endLine = lines.second,
			quality = "exact",
			symbolId = "lexicon typescript $SANDBOX_MODULE $name.",
		)
	}
	return Message(
		fromMe = false,
		text = "Opened both.",
		at = now,
		files = listOf(MessageFile(name = "refs", mime = "text/plain", role = "ref-snapshot", ref = RefFileMeta(SANDBOX_MODULE, keys = keys))),
	)
}

private val KNOWLEDGE_QUESTIONS = listOf("describe", "why", "relate", "contract", "effects", "usage")

/** A canned workspace, so every workspace screen draws with no session to reach. */
internal class SandboxWorkspaceGateway(now: () -> Long) : WorkspaceGateway {
	private val modules = sandboxModules()

	private val facets = SandboxFacets(modules, now)

	/** The host feeds every sent message here, so an Ask records itself over the next few reads. */
	val scopes = SandboxScopes(modules, now)

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

	private val module = SANDBOX_MODULE

	private fun idOf(name: String) = "lexicon typescript $module $name."

	private suspend fun <T> asSeeded(target: WorkspaceTarget, answer: () -> T): WorkspaceAnswer<T> =
		seeded(target) { WorkspaceAnswer.Read(answer()) }

	/**
	 * Keyed by SESSION, which is what a workspace belongs to. One of the two seeded sessions refuses,
	 * so the refusal notice is reachable; the empty Gateway holds no session to ask.
	 */
	private suspend fun <T> seeded(target: WorkspaceTarget, answer: () -> WorkspaceAnswer<T>): WorkspaceAnswer<T> {
		delay(WORKSPACE_ROUND_TRIP_MS)
		return if (target.address.endsWith(".other")) notServed else answer()
	}

	/** The plugin's rules over a canned tree. `src/generated` stays empty for its notice. */
	private val table = WorkspaceFileTable(
		folders = listOf("src", "src/generated", "src/shared") + sandboxFolders(modules.keys),
		files = listOf("AGENTS.md", READ_ONLY_FILE, UNHASHED_FILE, module, MANY_KINDS_FILE)
			.associateWith { file.joinToString("\n") } + modules.mapValues { it.value.text },
	)

	private suspend fun served(target: WorkspaceTarget): Boolean {
		delay(WORKSPACE_ROUND_TRIP_MS)
		return !target.address.endsWith(".other")
	}

	private val notServed = WorkspaceAnswer.Refused("this workspace is not served here")

	/** Shown too large to edit, and too large to hash. Paths are the table's, so a spelling cannot dodge them. */
	private fun shownBytes(path: String, bytes: Long?) =
		when (path) {
			READ_ONLY_FILE -> 912_000L
			UNHASHED_FILE -> 300_000_000L
			else -> bytes
		}

	override suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer> {
		if (!served(target)) return notServed
		val listing = table.tree(path) as? WorkspaceAnswer.Read ?: return table.tree(path)
		return WorkspaceAnswer.Read(
			listing.value.copy(
				root = SANDBOX_ROOT,
				entries = listing.value.entries.map {
					val child = childPath(listing.value.path, it.name)
					val bytes = shownBytes(child, it.bytes)
					// Over the plugin's counting cap.
					it.copy(bytes = bytes, lines = if (bytes != it.bytes) null else it.lines)
				},
			),
		)
	}

	override suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> {
		if (!served(target)) return notServed
		val canonical = table.canonical(path)
		if (canonical == UNHASHED_FILE) return WorkspaceAnswer.Refused("$path is too large to read")
		val read = table.read(path) as? WorkspaceAnswer.Read ?: return table.read(path)
		if (canonical != READ_ONLY_FILE) return read
		return WorkspaceAnswer.Read(read.value.copy(hash = null, readOnly = "$path is over the editing limit"))
	}

	/**
	 * Real spans only over the canned text, unedited; any typing past that draws plain. Several paths
	 * share the generic `file` body, as `table`'s own construction does.
	 */
	override suspend fun paintText(target: WorkspaceTarget, path: String, text: String): WorkspaceAnswer<WorkspacePaintTextAnswer> {
		if (!served(target)) return notServed
		val canned = modules[table.canonical(path)]
		val cannedText = canned?.text ?: file.joinToString("\n")
		val language = canned?.language ?: "typescript"
		val spans = if (text == cannedText) text.split("\n").map { sandboxSpans(language, it) } else null
		return WorkspaceAnswer.Read(WorkspacePaintTextAnswer(path = path, textHash = sha256Hex(text), spans = spans))
	}

	override suspend fun fileState(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceFileStateAnswer> {
		if (!served(target)) return notServed
		val state = table.state(path) as? WorkspaceAnswer.Read ?: return table.state(path)
		val shown = state.value.copy(bytes = shownBytes(state.value.path, state.value.bytes))
		return WorkspaceAnswer.Read(if (shown.path == UNHASHED_FILE) shown.copy(hash = null, identity = null) else shown)
	}

	override suspend fun symbolFacet(target: WorkspaceTarget, symbolId: String, facet: WorkspaceFacet) =
		seeded(target) { facets.facet(symbolId, facet) }

	override suspend fun fileHistory(target: WorkspaceTarget, path: String) =
		seeded(target) { facets.fileHistory(table.canonical(path) ?: path) }

	override suspend fun knowledgeScope(target: WorkspaceTarget, scope: WorkspaceKnowledgeScopeTarget, includeLocals: Boolean) =
		seeded(target) { scopes.scope(target.address, scope, includeLocals) }

	/** AGENTS.md always reads as moved on a write, so the stale banner is reachable. */
	override suspend fun mutateFile(
		target: WorkspaceTarget,
		mutation: WorkspaceFileMutation,
	): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		if (!served(target)) return notServed
		if (mutation is WorkspaceFileMutation.Write && table.canonical(mutation.path) == "AGENTS.md") {
			table.put(mutation.path, "# Agents\n\nChanged by the agent.")
			return WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = mutation.path, outcome = MUTATION_STALE))
		}
		return table.mutate(mutation)
	}

	private val manyKinds = listOf(
		"property" to 6, "constant" to 5, "variable" to 4, "type" to 3, "function" to 3, "method" to 2, "class" to 1,
		"interface" to 1, "enum" to 1,
	).flatMap { (kind, count) -> (1..count).map { kind to "$kind$it" } }

	private fun outlineOf(canned: SandboxModule) = WorkspaceOutlineAnswer(
		path = canned.path,
		root = SANDBOX_ROOT,
		lines = canned.lines.size.toLong(),
		symbols = canned.symbols.map {
			WorkspaceOutlineSymbol(
				symbolId = it.symbolId,
				name = it.name,
				symbolKind = it.kind,
				containerId = it.containerId,
				signature = it.signature,
				startLine = it.startLine,
			)
		},
	)

	private fun sourceOf(canned: SandboxModule, symbol: SandboxSymbol): WorkspaceSymbolSourceAnswer {
		val from = (symbol.startLine - 1).toInt().coerceIn(0, canned.lines.size)
		val to = symbol.endLine.toInt().coerceIn(from, canned.lines.size)
		val span = canned.lines.subList(from, to)
		return WorkspaceSymbolSourceAnswer(
			symbolId = symbol.symbolId,
			module = canned.path,
			name = symbol.name,
			text = span.joinToString("\n"),
			startLine = symbol.startLine,
			endLine = symbol.endLine,
			spanHash = "sandbox-${symbol.symbolId.hashCode()}",
			container = symbol.containerId?.let { id -> canned.symbols.firstOrNull { it.symbolId == id }?.name },
			spans = span.map { sandboxSpans(canned.language, it) },
		)
	}

	/** Every question, none recorded, as a symbol nobody has written about answers. */
	private fun knowledgeOf(canned: SandboxModule, symbol: SandboxSymbol): WorkspaceKnowledgeAnswer {
		val counts = facets.counts(symbol.symbolId)
		return WorkspaceKnowledgeAnswer(
			symbolId = symbol.symbolId,
			name = symbol.name,
			symbolKind = symbol.kind,
			module = canned.path,
			documentation = facets.documentation(symbol.symbolId),
			answers = KNOWLEDGE_QUESTIONS.map { WorkspaceKnowledgeEntry(question = it) },
			facts = counts?.let {
				WorkspaceKnowledgeFacts(
					members = it.members,
					references = it.uses,
					fanIn = it.dependents,
					fanOut = it.targets,
					supertypes = it.supertypes,
					subtypes = it.subtypes,
					comments = it.comments,
					counts = it,
				)
			},
		)
	}

	override suspend fun outline(target: WorkspaceTarget, path: String) =
		asSeeded(target) {
			modules[table.canonical(path)]?.let { return@asSeeded outlineOf(it) }
			if (table.canonical(path) == MANY_KINDS_FILE) {
				return@asSeeded WorkspaceOutlineAnswer(
					path = path,
					root = SANDBOX_ROOT,
					lines = manyKinds.size.toLong(),
					symbols = manyKinds.mapIndexed { index, (kind, name) ->
						WorkspaceOutlineSymbol(
							symbolId = "lexicon typescript $MANY_KINDS_FILE $name.",
							name = name,
							symbolKind = kind,
							startLine = index + 1L,
						)
					},
				)
			}
			WorkspaceOutlineAnswer(
				path = path,
				root = SANDBOX_ROOT,
				lines = file.size.toLong(),
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
			facets.symbolOf(symbolId)?.let { (canned, symbol) -> return@asSeeded sourceOf(canned, symbol) }
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
			facets.symbolOf(symbolId)?.let { (canned, symbol) -> return@asSeeded knowledgeOf(canned, symbol) }
			val refusal = symbolId.contains("routineRefusal")
			WorkspaceKnowledgeAnswer(
				symbolId = symbolId,
				name = if (refusal) "routineRefusal" else "MAX_ROUTINE_MEMORY_BYTES",
				symbolKind = if (refusal) "function" else "constant",
				module = module,
				documentation = if (refusal) "Why a routine cannot be stored, or null." else "What a routine may remember, in UTF-8 BYTES.",
				// Every row shape draws.
				answers = listOf(
					WorkspaceKnowledgeEntry(
						question = "describe",
						prose = "Returns the reason a routine cannot be stored, or null when it can.",
						thin = true,
					),
					WorkspaceKnowledgeEntry(
						question = "why",
						prose = "A rule that parses can still name nothing, so the refusal asks the recurrence calculator.",
						stale = true,
					),
					WorkspaceKnowledgeEntry(question = "relate"),
					WorkspaceKnowledgeEntry(question = "contract"),
					WorkspaceKnowledgeEntry(question = "effects"),
					WorkspaceKnowledgeEntry(question = "usage"),
				),
				facts = WorkspaceKnowledgeFacts(
					members = 0,
					references = 4,
					fanIn = 3,
					fanOut = 5,
					supertypes = 0,
					subtypes = 0,
					comments = 1,
				),
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
