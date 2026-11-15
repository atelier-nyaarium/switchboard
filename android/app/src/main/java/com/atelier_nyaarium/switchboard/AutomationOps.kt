package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

internal interface AutomationGateway {
	suspend fun list(gatewayId: String): ListAnswer<AutomationRow>

	suspend fun put(gatewayId: String, automationId: String, automation: Automation, baseRevision: Long): ConsoleAutomationPutResult

	suspend fun delete(gatewayId: String, automationId: String, baseRevision: Long): ConsoleAutomationDeleteResult

	suspend fun preview(gatewayId: String, trigger: AutomationTrigger): ConsoleAutomationPreviewResult?
}

internal interface AutomationHost {
	val gateway: AutomationGateway?

	/** Under the assistant's move lock; false once the home has left `gatewayId`. */
	suspend fun carried(gatewayId: String, write: suspend () -> Unit): Boolean {
		write()
		return true
	}
}

internal const val HOME_MOVED = "The assistant moved to another Gateway"

/** A gateway answer, never a Boolean. */
internal sealed interface AutomationSaved {
	/** Null after a delete. */
	data class Stored(val row: AutomationRow?) : AutomationSaved

	/** The held row names what it lost to. */
	data class Refused(val reason: String, val heldRow: AutomationRow? = null) : AutomationSaved

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

	/** The editor's edits; its line is what the last send said. */
	val edits = EditorSessions<AutomationDraftKey, AutomationDraft, String>(
		changed = { draft, opened -> draft.changedFrom(opened) },
		unattended = { left -> tell(leftLine("", "Automation", left.said.orEmpty())) },
	)

	private fun tell(message: String) = state.update { it.copy(transientMessages = it.transientMessages + message) }

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
	): EditOutcome<AutomationDraft, String>? = edits.send(key, opening) { sent ->
		when (val outcome = outcomeOf(op(sent), sent, deleting)) {
			AutomationOutcome.Done -> EditOutcome.Done
			is AutomationOutcome.Offer -> EditOutcome.Stays(outcome.line, outcome.draft, reopened = deleting)
			is AutomationOutcome.Said -> EditOutcome.Stays(outcome.reason)
		}
	}

	suspend fun refreshAll() {
		refreshEach(state.value.gateways.ids(), ::refresh)
	}

	suspend fun refresh(gatewayId: String) {
		if (gatewayId.isBlank()) return
		val client = host.gateway
		val read = reads.list(TAG, gatewayId, client?.let { held -> suspend { held.list(gatewayId) } }) ?: return
		// Remove 2026-11-29: with the prose shim.
		// A Gateway that answers sources serves this list, so its refusal is a fault.
		val serves = servesSources(state.value.gateways.assistantOn(gatewayId))
		val answer = if (read == ListAnswer.NotServed && serves) ListAnswer.Unreachable else read
		state.update { held ->
			held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(automations = it.automations.after(answer)) })
		}
	}

	suspend fun save(
		gatewayId: String,
		id: String,
		automation: Automation,
		base: Long,
	): AutomationSaved {
		if (gatewayId.isBlank()) return AutomationSaved.Unreachable
		var answer: ConsoleAutomationPutResult? = null
		val here = host.carried(gatewayId) {
			answer = host.gateway?.let { client -> attempt { client.put(gatewayId, id, automation, base) } }
		}
		if (!here) return AutomationSaved.Refused(HOME_MOVED)
		val stored = answer ?: return AutomationSaved.Unreachable
		refresh(gatewayId)
		return saved(stored)
	}

	/** A refusal names the row as re-read. */
	suspend fun delete(gatewayId: String, id: String, base: Long): AutomationSaved {
		if (gatewayId.isBlank()) return AutomationSaved.Unreachable
		var answer: ConsoleAutomationDeleteResult? = null
		val here = host.carried(gatewayId) {
			answer = host.gateway?.let { client -> attempt { client.delete(gatewayId, id, base) } }
		}
		if (!here) return AutomationSaved.Refused(HOME_MOVED)
		val deleted = answer ?: return AutomationSaved.Unreachable
		refresh(gatewayId)
		if (deleted.deleted) return AutomationSaved.Stored(null)
		return AutomationSaved.Refused(deleted.reason ?: "This Gateway kept it", state.value.gateways.automationOn(gatewayId, id).found())
	}

	suspend fun setEnabled(gatewayId: String, row: AutomationRow, enabled: Boolean): AutomationSaved =
		toggles.run(gatewayId, row.id, ::toggleLine) {
			val answer = if (gatewayId.isBlank()) {
				AutomationSaved.Unreachable
			} else {
				var result: ConsoleAutomationPutResult? = null
				val here = host.carried(gatewayId) {
					result = host.gateway?.let { client ->
						attempt { client.put(gatewayId, row.id, row.automation.copy(enabled = enabled), row.revision) }
					}
				}
				val put = result
				when {
					!here -> AutomationSaved.Refused(HOME_MOVED)
					put == null -> AutomationSaved.Unreachable
					else -> saved(put)
				}
			}
			refresh(gatewayId)
			answer
		}

	private fun toggleLine(saved: AutomationSaved): String? = when (saved) {
		is AutomationSaved.Stored -> null
		is AutomationSaved.Refused -> saved.reason
		AutomationSaved.Unreachable -> GATEWAY_UNREACHABLE
	}

	suspend fun preview(gatewayId: String, trigger: AutomationTrigger): ConsoleAutomationPreviewResult? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.preview(gatewayId, trigger) }
	}

	private fun saved(answer: ConsoleAutomationPutResult): AutomationSaved = when {
		answer.stored && answer.row != null -> AutomationSaved.Stored(answer.row)
		else -> AutomationSaved.Refused(answer.reason ?: "This Gateway holds a different copy", answer.row)
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Automation"
	}
}
