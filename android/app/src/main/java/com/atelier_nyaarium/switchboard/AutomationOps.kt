package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.movesWithHome
import com.atelier_nyaarium.switchboard.assistant.offerOn
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** A Gateway's rows, and the kinds it says it holds. */
internal data class AutomationListing(val rows: ListAnswer<AutomationRow>, val serves: AutomationServes? = null)

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

	/** `text` is a message whose holes to fill. */
	suspend fun preview(gatewayId: String, trigger: AutomationTrigger, text: String?): ConsoleAutomationPreviewResult?
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

/** A gateway answer, never a Boolean. */
internal sealed interface AutomationSaved {
	/** Null after a delete. */
	data class Stored(val row: AutomationRow?) : AutomationSaved

	/** The held row names what it lost to; `confirm` and `hole` say what to ask or mark. */
	data class Refused(
		val reason: String,
		val heldRow: AutomationRow? = null,
		val confirm: List<String> = emptyList(),
		val hole: AutomationHoleSpan? = null,
	) : AutomationSaved

	data object Unreachable : AutomationSaved
}

internal data class AutomationDraftKey(val gatewayId: String, val slot: AutomationSlot)

/** Nothing held on the phone; a change re-reads. */
internal class AutomationOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: AutomationHost,
) : ClearsOnReprovision {
	private val reads = GatewayReadFence()

	val toggles = ToggleFence()

	/** The editor's edits, with what the last send said. */
	val edits = EditorSessions<AutomationDraftKey, AutomationDraft, AutomationSaid>(
		changed = { draft, opened -> draft.changedFrom(opened) },
		unattended = { left -> tell(leftLine("", "Automation", left.said?.line.orEmpty())) },
		inner = { draft -> draft.takeIf { it.text != null }?.copy(text = null) },
	)

	private fun tell(message: String) = state.update { it.copy(transientMessages = it.transientMessages + message) }

	/** Null while its list is unread. */
	private fun heldMoves(gatewayId: String, id: String): Boolean? =
		state.value.gateways.automationOn(gatewayId, id).found()?.automation?.let(::movesWithHome)

	/** Stored row or its draft moves with the home. */
	fun editsEvent(key: AutomationDraftKey): Boolean {
		val held = (key.slot as? AutomationSlot.Held)?.let { heldMoves(key.gatewayId, it.id) }
		return held == true || edits.state.value.held[key]?.draft?.trigger is TriggerDraft.Event
	}

	override suspend fun clearInMemory() {
		reads.clear()
		toggles.clear()
		edits.clear()
	}

	/** A delete's offer is the held row, not an edit. */
	suspend fun send(
		key: AutomationDraftKey,
		opening: Long,
		deleting: Boolean,
		op: suspend (AutomationDraft) -> AutomationSaved,
	): EditOutcome<AutomationDraft, AutomationSaid>? = edits.send(key, opening) { sent ->
		val held = state.value
		val offer = offerOn(held.gateways.entry(key.gatewayId), away = assistantGateway(held) != key.gatewayId)
		when (val outcome = outcomeOf(op(sent), sent, deleting, offer)) {
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
		val call = client?.let { held ->
			suspend {
				val listing = held.list(gatewayId)
				listedServes = listing.serves
				listing.rows
			}
		}
		val read = reads.list(TAG, gatewayId, call) ?: return
		// Remove 2026-11-29: with the prose shim.
		// A Gateway that answers sources serves this list, so its refusal is a fault.
		val serves = servesSources(state.value.gateways.assistantOn(gatewayId))
		val answer = if (read == ListAnswer.NotServed && serves) ListAnswer.Unreachable else read
		state.update { held ->
			held.copy(
				gateways = held.gateways.withEntry(gatewayId) {
					// Only a listed answer says what is served.
					val serves = if (answer is ListAnswer.Listed) listedServes else it.automationServes
					it.copy(automations = it.automations.after(answer), automationServes = serves)
				},
			)
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

	private suspend fun put(gatewayId: String, id: String, automation: Automation, base: Long, confirmed: Boolean): AutomationSaved =
		when (val written = write(gatewayId, movesWithHome(automation) || heldMoves(gatewayId, id) == true) { it.put(gatewayId, id, automation, base, confirmed) }) {
			Written.Moved -> AutomationSaved.Refused(HOME_MOVED)
			Written.Unreachable -> AutomationSaved.Unreachable
			is Written.Answered -> {
				refresh(gatewayId)
				saved(written.answer)
			}
		}

	suspend fun save(
		gatewayId: String,
		id: String,
		automation: Automation,
		base: Long,
		confirmed: Boolean = false,
	): AutomationSaved = put(gatewayId, id, automation, base, confirmed)

	/** Unread row is taken to move. */
	suspend fun delete(gatewayId: String, id: String, base: Long): AutomationSaved =
		when (val written = write(gatewayId, heldMoves(gatewayId, id) ?: true) { it.delete(gatewayId, id, base) }) {
			Written.Moved -> AutomationSaved.Refused(HOME_MOVED)
			Written.Unreachable -> AutomationSaved.Unreachable
			is Written.Answered -> {
				refresh(gatewayId)
				val deleted = written.answer
				if (deleted.deleted) AutomationSaved.Stored(null)
				else AutomationSaved.Refused(deleted.reason ?: "This Gateway kept it", state.value.gateways.automationOn(gatewayId, id).found())
			}
		}

	suspend fun setEnabled(gatewayId: String, row: AutomationRow, enabled: Boolean): AutomationSaved =
		toggles.run(gatewayId, row.id, ::toggleLine) {
			put(gatewayId, row.id, row.automation.copy(enabled = enabled), row.revision, false)
		}

	private fun toggleLine(saved: AutomationSaved): String? = when (saved) {
		is AutomationSaved.Stored -> null
		is AutomationSaved.Refused -> saved.reason
		AutomationSaved.Unreachable -> GATEWAY_UNREACHABLE
	}

	suspend fun preview(gatewayId: String, trigger: AutomationTrigger, text: String? = null): ConsoleAutomationPreviewResult? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.preview(gatewayId, trigger, text) }
	}

	private fun saved(answer: ConsoleAutomationPutResult): AutomationSaved = when {
		answer.stored && answer.row != null -> AutomationSaved.Stored(answer.row)
		else -> AutomationSaved.Refused(
			answer.reason ?: "This Gateway holds a different copy",
			answer.row,
			answer.confirm.orEmpty(),
			answer.hole,
		)
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Automation"
	}
}
