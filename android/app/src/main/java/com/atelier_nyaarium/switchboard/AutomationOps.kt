package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.FunctionOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.fieldsOf
import com.atelier_nyaarium.switchboard.assistant.keyGone
import com.atelier_nyaarium.switchboard.assistant.SaveAnswer
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.refusedAtOf
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.RefusedAt
import com.atelier_nyaarium.switchboard.assistant.RefusedHole
import com.atelier_nyaarium.switchboard.assistant.refusedHoleOf
import com.atelier_nyaarium.switchboard.assistant.movedAutomation
import com.atelier_nyaarium.switchboard.assistant.movesWithHome
import com.atelier_nyaarium.switchboard.assistant.pointerOf
import com.atelier_nyaarium.switchboard.assistant.RunsDraft
import com.atelier_nyaarium.switchboard.assistant.reloadable
import com.atelier_nyaarium.switchboard.assistant.reloadedFunction
import com.atelier_nyaarium.switchboard.assistant.saveAnswerOf
import com.atelier_nyaarium.switchboard.assistant.automationContext
import com.atelier_nyaarium.switchboard.assistant.over
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationCheckResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationRunResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptParseResult
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptPrintResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** A Gateway's rows, and the kinds it says it holds. */
internal data class AutomationListing(
	val rows: ListAnswer<AutomationRow>,
	val serves: AutomationServes? = null,
	/** Not served read from prose, not the token. */
	val prose: Boolean = false,
	/** From the same read as the rows. */
	val functions: List<AutomationFunctionRow>? = null,
)

internal interface AutomationGateway {
	suspend fun list(gatewayId: String): AutomationListing

	/** `confirmed` once the owner agreed to its dangerous actions. */
	suspend fun put(
		gatewayId: String,
		automationId: String,
		automation: Automation,
		baseRevision: Long,
		confirmed: Boolean,
	): ConsoleAutomationPutResult

	suspend fun delete(gatewayId: String, automationId: String, baseRevision: Long): ConsoleAutomationDeleteResult

	/** With its function, as one write. */
	suspend fun save(gatewayId: String, op: ConsoleOp.AutomationSave): ConsoleAutomationSaveResult

	suspend fun check(gatewayId: String, op: ConsoleOp.AutomationCheck): ConsoleAutomationCheckResult?

	suspend fun preview(gatewayId: String, ask: ConsoleOp.AutomationPreview): ConsoleAutomationPreviewResult?

	/** `callId` joins retries. */
	suspend fun run(gatewayId: String, automationId: String, callId: String): AutomationRan

	suspend fun scriptPrint(gatewayId: String, op: ConsoleOp.ScriptPrint): ConsoleScriptPrintResult?

	suspend fun scriptParse(gatewayId: String, op: ConsoleOp.ScriptParse): ConsoleScriptParseResult?

	suspend fun scriptVocabulary(gatewayId: String): ConsoleDescribeResult?
}

internal sealed interface AutomationRan {
	data object Started : AutomationRan

	/** Null means unknown refusal. */
	data class Refused(val refusal: Protocol.Wire.AutomationRunRefusal?) : AutomationRan

	data object NotServed : AutomationRan

	data object Unreachable : AutomationRan
}

internal fun ranOf(result: ConsoleAutomationRunResult): AutomationRan =
	if (result.ran) AutomationRan.Started
	else AutomationRan.Refused(Protocol.Wire.AutomationRunRefusal.entries.find { it.wire == result.refusal })

internal data class RunKey(val gatewayId: String, val automationId: String)

internal sealed interface RunState {
	data object Asking : RunState

	/** Drawn only for the opening that asked. */
	data class Said(val ran: AutomationRan, val opening: Long) : RunState
}

internal interface AutomationHost {
	val gateway: AutomationGateway?

	/** Under the assistant's move lock; false once the home has left `gatewayId`. */
	suspend fun carried(gatewayId: String, write: suspend () -> Unit): Boolean {
		write()
		return true
	}
}

/** One write's answer, or why there is none. */
private sealed interface Written<out T> {
	data class Answered<T>(val answer: T) : Written<T>

	data object Moved : Written<Nothing>

	data object Unreachable : Written<Nothing>
}

internal const val HOME_MOVED = "The assistant moved to another Gateway"

internal fun functionWriteMoves(bodies: List<Automation?>, gatewayId: String, home: String?, functions: FunctionOffer?): Boolean =
	bodies.filterNotNull().any { body ->
		movesWithHome(body) || pointerOf(body)?.let { id -> functions?.row(id)?.let { it.moves } ?: (gatewayId == home) } == true
	}

/** A gateway answer, never a Boolean. */
internal sealed interface AutomationSaved {
	/** Null after a delete. */
	data class Stored(val row: AutomationRow?) : AutomationSaved

	/** The held row names what it lost to; `confirm` and `hole` say what to ask or mark. */
	data class Refused(
		val reason: String,
		val heldRow: AutomationRow? = null,
		val confirm: List<String> = emptyList(),
		val hole: RefusedHole? = null,
		val at: RefusedAt? = null,
		val functionMoved: MovedFunction? = null,
	) : AutomationSaved

	data object Unreachable : AutomationSaved
}

/** Rebases only onto a held row. */
internal fun keptRow(held: Lookup<AutomationRow>): AutomationRow? = when (held) {
	is Lookup.Found -> held.row
	Lookup.Gone, Lookup.Reading, Lookup.Unreachable, Lookup.NotServed -> null
}

internal fun automationSavedOf(
	answer: ConsoleAutomationSaveResult,
	id: String,
	heldRow: AutomationRow? = null,
): AutomationSaved =
	when (val read = saveAnswerOf(answer)) {
		is SaveAnswer.Stored -> AutomationSaved.Stored(read.automation)
		is SaveAnswer.Confirm -> AutomationSaved.Refused(
			automationSaveLine(Protocol.Wire.AutomationSaveRefusalCode.CONFIRM, answer.refusal),
			confirm = read.labels,
		)
		is SaveAnswer.Hole -> AutomationSaved.Refused(
			automationSaveLine(Protocol.Wire.AutomationSaveRefusalCode.HOLE, answer.refusal),
			hole = refusedHoleOf(read),
		)
		is SaveAnswer.Refused -> AutomationSaved.Refused(
			automationSaveLine(read.code, read.refusal, id),
			heldRow = heldRow.takeIf { movedAutomation(read) },
			at = refusedAtOf(read.refusal),
			functionMoved = MovedFunction(read.refusal.id).takeIf {
				read.code == Protocol.Wire.AutomationSaveRefusalCode.MOVED &&
					read.refusal.record == Protocol.Wire.AutomationSaveRecord.FUNCTION.wire
			},
		)
	}

/** `null` means pointed function. */
internal data class MovedFunction(val id: String?)

internal data class AutomationDraftKey(val gatewayId: String, val slot: AutomationSlot)

/** Text, script, picker, callee. */
internal val AUTOMATION_PAGES = InnerPages<AutomationDraft>(
	open = { draft ->
		listOf(draft.text, draft.scriptPage, draft.picking, draft.inside)
			.takeIf { draft.text != null || draft.scriptPage != null || draft.picking || draft.inside.isNotEmpty() }
	},
	close = { draft ->
		when {
			draft.text != null -> draft.copy(text = null)
			draft.scriptPage != null -> draft.copy(scriptPage = null)
			draft.picking -> draft.copy(picking = false)
			else -> draft.copy(inside = draft.inside.dropLast(1))
		}
	},
)

/** Nothing held on the phone; a change re-reads. */
internal class AutomationOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: AutomationHost,
) : ClearsOnReprovision {
	private val reads = GatewayReadFence()

	val toggles = ToggleFence()

	val runs = MutableStateFlow<Map<RunKey, RunState>>(emptyMap())

	/** Vocabulary by Gateway. */
	val scriptWords = MutableStateFlow<Map<String, ConsoleDescribeResult>>(emptyMap())

	/** The editor's edits, with what the last send said. */
	val edits = EditorSessions<AutomationDraftKey, AutomationDraft, AutomationSaid>(
		changed = { draft, opened -> draft.changedFrom(opened) },
		unattended = { left -> tell(leftLine("", "Automation", left.said?.line.orEmpty())) },
		inner = AUTOMATION_PAGES,
		clears = { said, next -> said is AutomationSaid.Confirm || said is AutomationSaid.Note || keyGone(said, next) },
	)

	private fun tell(message: String) = state.update { it.withNotice(message) }

	/** What is stored moves with the home, never what is typed. */
	fun editsEvent(key: AutomationDraftKey): Boolean {
		val slot = key.slot as? AutomationSlot.Held ?: return false
		val session = edits.state.value.held[key]
		if (session != null) return session.draft.original?.let(::movesWithHome) == true
		return when (val held = state.value.gateways.automationOn(key.gatewayId, slot.id)) {
			is Lookup.Found -> movesWithHome(held.row.automation)
			Lookup.Gone, Lookup.Reading, Lookup.Unreachable, Lookup.NotServed -> false
		}
	}

	override suspend fun clearInMemory() {
		reads.clear()
		toggles.clear()
		edits.clear()
		runs.value = emptyMap()
		scriptWords.value = emptyMap()
	}

	/** Retry reuses unanswered tap's id. */
	private val unanswered = java.util.concurrent.ConcurrentHashMap<RunKey, String>()

	suspend fun run(gatewayId: String, automationId: String, opening: Long): AutomationRan {
		val key = RunKey(gatewayId, automationId)
		var claimed = false
		runs.update { held ->
			claimed = held[key] != RunState.Asking
			if (claimed) held + (key to RunState.Asking) else held
		}
		if (!claimed) return AutomationRan.Unreachable
		val callId = unanswered.getOrPut(key) { java.util.UUID.randomUUID().toString() }
		val ran = host.gateway?.let { gateway -> attempt { gateway.run(gatewayId, automationId, callId) } } ?: AutomationRan.Unreachable
		if (ran != AutomationRan.Unreachable) unanswered.remove(key, callId)
		runs.update { it + (key to RunState.Said(ran, opening)) }
		if (ran == AutomationRan.Started) refresh(gatewayId)
		return ran
	}

	suspend fun commit(key: AutomationDraftKey, opening: Long, confirmed: Boolean): EditOutcome<AutomationDraft, AutomationSaid>? =
		send(key, opening, deleting = false) { sent, heard ->
			val fields = fieldsOf(sent, heard.sources)
			// Functions only where served.
			if (heard.offer.functions != null) {
				functionSaveOf(sent, fields, heard.offer, confirmed)
					?.let { saveWithFunction(key.gatewayId, it, sent.original, heard.offer) }
					?: AutomationSaved.Refused("Not a complete automation")
			} else {
				fittingAutomation(sent, fields, heard.offer)
					?.let { save(key.gatewayId, sent.id, it, sent.revision, sent.original, confirmed) }
					?: AutomationSaved.Refused("Not a complete automation")
			}
		}

	/** A function write moves when any of its users does. */
	private suspend fun saveWithFunction(gatewayId: String, op: ConsoleOp.AutomationSave, stored: Automation?, offer: AutomationOffer): AutomationSaved {
		val home = assistantGateway(state.value)
		val functionMoves = functionWriteMoves(listOf(op.automation, stored), gatewayId, home, offer.functions)
		return when (val written = write(gatewayId, functionMoves) { it.save(gatewayId, op) }) {
			Written.Moved -> AutomationSaved.Refused(HOME_MOVED)
			Written.Unreachable -> AutomationSaved.Unreachable
			is Written.Answered -> {
				refresh(gatewayId)
				automationSavedOf(
					written.answer,
					op.automationId,
					keptRow(state.value.gateways.automationOn(gatewayId, op.automationId)),
				)
			}
		}
	}

	suspend fun remove(key: AutomationDraftKey, opening: Long): EditOutcome<AutomationDraft, AutomationSaid>? =
		send(key, opening, deleting = true) { sent, _ ->
			sent.original?.let { delete(key.gatewayId, sent.id, sent.revision, it) } ?: AutomationSaved.Refused("Not a stored automation")
		}

	/** A delete offers the held row. */
	private suspend fun send(
		key: AutomationDraftKey,
		opening: Long,
		deleting: Boolean,
		op: suspend (AutomationDraft, EditContext) -> AutomationSaved,
	): EditOutcome<AutomationDraft, AutomationSaid>? = edits.send(key, opening) { sent ->
		val held = state.value
		val heard = automationContext(held.gateways, held.assistantHome, key.gatewayId).over(sent.context)
		when (val outcome = outcomeOf(op(sent, heard), sent, deleting, heard)) {
			AutomationOutcome.Done -> EditOutcome.Done
			is AutomationOutcome.Offer -> EditOutcome.Stays(AutomationSaid.Line(outcome.line), outcome.draft, reopened = deleting)
			is AutomationOutcome.Said -> EditOutcome.Stays(outcome.said)
		}
	}

	suspend fun refreshAll() {
		refreshEach(state.value.gateways.ids(), ::refresh)
	}

	suspend fun refresh(gatewayId: String) {
		if (gatewayId.isBlank()) return
		val client = host.gateway
		var listedServes: AutomationServes? = null
		var listedFunctions: List<AutomationFunctionRow>? = null
		var prose = false
		val call = client?.let { held ->
			suspend {
				val listing = held.list(gatewayId)
				listedServes = listing.serves
				listedFunctions = listing.functions
				prose = listing.prose
				listing.rows
			}
		}
		val read = reads.list(TAG, gatewayId, call) ?: return
		// Remove 2026-11-29: with the prose shim.
		val older = saysOlderBuild(state.value.gateways.assistantRead(gatewayId))
		val answer = if (read == ListAnswer.NotServed && prose && !older) ListAnswer.Unreachable else read
		state.update { held ->
			held.copy(
				gateways = held.gateways.withEntry(gatewayId) {
					val after = it.copy(automations = it.automations.after(answer))
					// Only a listed answer says what is served.
					when (answer) {
						is ListAnswer.Listed -> after.copy(automationServes = listedServes, automationFunctions = listedFunctions)
						ListAnswer.NotServed, ListAnswer.Unreachable -> after
					}
				},
			)
		}
		when (answer) {
			is ListAnswer.Listed -> freshenEdits(gatewayId)
			ListAnswer.NotServed, ListAnswer.Unreachable -> Unit
		}
	}

	/** Open edits re-read untouched callee copies. */
	private fun freshenEdits(gatewayId: String) {
		val held = state.value
		for ((key, session) in edits.state.value.held) {
			if (key.gatewayId != gatewayId) continue
			val offer = automationContext(held.gateways, held.assistantHome, gatewayId).over(session.draft.context).offer
			if (session.draft.freshened(offer) != session.draft) edits.edit(key, session.opening) { it.freshened(offer) }
		}
	}

	/** Stored or sent row that moves takes the lock. */
	private suspend fun <T : Any> write(gatewayId: String, moves: Boolean, call: suspend (AutomationGateway) -> T): Written<T> {
		if (gatewayId.isBlank()) return Written.Unreachable
		var answer: T? = null
		val send: suspend () -> Unit = { answer = host.gateway?.let { client -> attempt { call(client) } } }
		if (!moves) send() else if (!host.carried(gatewayId, send)) return Written.Moved
		return answer?.let { Written.Answered(it) } ?: Written.Unreachable
	}

	private suspend fun put(
		gatewayId: String,
		id: String,
		automation: Automation,
		base: Long,
		stored: Automation?,
		confirmed: Boolean,
	): AutomationSaved {
		val moves = movesWithHome(automation) || stored?.let(::movesWithHome) == true
		return when (val written = write(gatewayId, moves) { it.put(gatewayId, id, automation, base, confirmed) }) {
			Written.Moved -> AutomationSaved.Refused(HOME_MOVED)
			Written.Unreachable -> AutomationSaved.Unreachable
			is Written.Answered -> {
				refresh(gatewayId)
				saved(written.answer)
			}
		}
	}

	/** `stored` is what the edit began from; null for a new one. */
	suspend fun save(
		gatewayId: String,
		id: String,
		automation: Automation,
		base: Long,
		stored: Automation?,
		confirmed: Boolean = false,
	): AutomationSaved = put(gatewayId, id, automation, base, stored, confirmed)

	/** `stored` is the body being deleted. */
	suspend fun delete(gatewayId: String, id: String, base: Long, stored: Automation): AutomationSaved =
		when (val written = write(gatewayId, movesWithHome(stored)) { it.delete(gatewayId, id, base) }) {
			Written.Moved -> AutomationSaved.Refused(HOME_MOVED)
			Written.Unreachable -> AutomationSaved.Unreachable
			is Written.Answered -> {
				refresh(gatewayId)
				val deleted = written.answer
				if (deleted.deleted) AutomationSaved.Stored(null)
				else AutomationSaved.Refused(deleted.reason ?: "This Gateway kept it", keptRow(state.value.gateways.automationOn(gatewayId, id)))
			}
		}

	suspend fun setEnabled(gatewayId: String, row: AutomationRow, enabled: Boolean): AutomationSaved =
		toggles.run(gatewayId, row.id, ::toggleLine) {
			put(gatewayId, row.id, row.automation.copy(enabled = enabled), row.revision, row.automation, false)
		}

	private fun toggleLine(saved: AutomationSaved): String? = when (saved) {
		is AutomationSaved.Stored -> null
		is AutomationSaved.Refused -> saved.reason
		AutomationSaved.Unreachable -> GATEWAY_UNREACHABLE
	}

	suspend fun preview(gatewayId: String, ask: ConsoleOp.AutomationPreview): ConsoleAutomationPreviewResult? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.preview(gatewayId, ask) }
	}

	suspend fun check(gatewayId: String, save: ConsoleOp.AutomationSave): ConsoleAutomationCheckResult? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		val op = ConsoleOp.AutomationCheck(
			automationId = save.automationId,
			automation = save.automation,
			automationBase = save.automationBase,
			function = save.function,
			called = save.called,
			functionBase = save.functionBase,
			confirmed = true,
		)
		return attempt { client.check(gatewayId, op) }
	}

	suspend fun scriptPrint(gatewayId: String, op: ConsoleOp.ScriptPrint): ConsoleScriptPrintResult? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.scriptPrint(gatewayId, op) }
	}

	suspend fun scriptParse(gatewayId: String, op: ConsoleOp.ScriptParse): ConsoleScriptParseResult? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.scriptParse(gatewayId, op) }
	}

	/** Refresh on each opening. */
	suspend fun describeScript(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val answer = attempt { client.scriptVocabulary(gatewayId) } ?: return
		scriptWords.update { it + (gatewayId to answer) }
	}

	/** `id`: pointer or callee. */
	suspend fun reloadFunction(key: AutomationDraftKey, opening: Long, id: String): EditOutcome<AutomationDraft, AutomationSaid>? =
		edits.send(key, opening) { sent ->
			refresh(key.gatewayId)
			val held = state.value
			val context = automationContext(held.gateways, held.assistantHome, key.gatewayId).over(sent.context)
			val pointing = (sent.runsDraft() as? RunsDraft.Pointing)?.takeIf { reloadable(sent.runsDraft()) == id }
			// Pointed body beats stale callee copy.
			val callee = sent.callees[id]?.takeIf { pointing == null }
			val base = callee?.base ?: pointing?.base
			val row = context.offer.functions?.row(id)
			when {
				base == null -> EditOutcome.Stays(null)
				row == null -> EditOutcome.Stays(AutomationSaid.Line("That function is no longer listed."))
				// Nothing newer was read.
				row.revision == base -> {
					tell(leftLine("", "Automation", GATEWAY_UNREACHABLE))
					EditOutcome.Stays(AutomationSaid.FunctionMoved(id))
				}
				else -> {
					val (draft, dropped) = if (callee != null) sent.reloadedCallee(row, context.offer) else sent.reloadedFunction(row, context.offer)
					val line = if (dropped) "Reloaded. Your changes to its steps were dropped." else "Reloaded."
					EditOutcome.Stays(AutomationSaid.Note(line), draft)
				}
			}
		}

	private fun saved(answer: ConsoleAutomationPutResult): AutomationSaved = when {
		answer.stored && answer.row != null -> AutomationSaved.Stored(answer.row)
		else -> AutomationSaved.Refused(
			answer.reason ?: "This Gateway holds a different copy",
			answer.row,
			answer.confirm.orEmpty(),
			answer.hole?.let(::refusedHoleOf),
		)
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Automation"
	}
}
