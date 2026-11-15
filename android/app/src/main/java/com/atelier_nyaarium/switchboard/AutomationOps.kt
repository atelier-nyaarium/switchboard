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
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet

internal interface AutomationGateway {
	suspend fun list(gatewayId: String): AutomationListAnswer

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

/** Opening fences draft settlement. */
internal data class HeldAutomationDraft(
	val draft: AutomationDraft,
	/** As the editor opened it. */
	val opened: AutomationDraft,
	val opening: Long,
	val said: String? = null,
	val busy: Boolean = false,
)

/** Back asks before discarding an edit. */
internal fun leaveAsks(held: HeldAutomationDraft?): Boolean = held != null && held.draft.changedFrom(held.opened)

/** A Back that asked, for one opening. */
internal data class LeaveAsk(val key: AutomationDraftKey, val opening: Long)

/** Shown over its own opening. */
internal fun leaveShown(ask: LeaveAsk?, key: AutomationDraftKey, held: HeldAutomationDraft?): Boolean =
	ask != null && ask.key == key && ask.opening == held?.opening

/** Nothing held on the phone; a change re-reads. */
internal class AutomationOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: AutomationHost,
) : ClearsOnReprovision {
	private val reads = GatewayReadFence()

	/** One counter per row. */
	private val toggles = GatewayReadFence()

	val toggleRefusals = androidx.compose.runtime.mutableStateOf<Map<Pair<String, String>, String>>(emptyMap())

	/** Success or Discard clears. */
	val drafts = MutableStateFlow<Map<AutomationDraftKey, HeldAutomationDraft>>(emptyMap())

	/** Landed opening per key. */
	val landed = MutableStateFlow<Map<AutomationDraftKey, Long>>(emptyMap())

	/** The editor Back was pressed on, changed. */
	val leaving = MutableStateFlow<LeaveAsk?>(null)

	private val openings = java.util.concurrent.atomic.AtomicLong()

	override suspend fun clearInMemory() {
		drafts.value = emptyMap()
		landed.value = emptyMap()
		leaving.value = null
		toggleRefusals.value = emptyMap()
	}

	/** No edits while its op is out. */
	fun edit(key: AutomationDraftKey, draft: AutomationDraft) {
		drafts.update { held ->
			val now = held[key]
			if (now == null || now.busy) held else held + (key to now.copy(draft = draft))
		}
	}

	/** The opening a send will settle. */
	fun hold(key: AutomationDraftKey, draft: AutomationDraft): Long {
		val minted = openings.incrementAndGet()
		return drafts.updateAndGet { held -> if (key in held) held else held + (key to HeldAutomationDraft(draft, draft, minted)) }
			.getValue(key).opening
	}

	fun discard(key: AutomationDraftKey) {
		drafts.update { it - key }
		leaving.update { if (it?.key == key) null else it }
	}

	fun askLeave(key: AutomationDraftKey): Boolean {
		val held = drafts.value[key]
		// A send in flight still lands.
		if (held?.busy == true) return true
		if (held == null || !leaveAsks(held)) {
			discard(key)
			return true
		}
		leaving.value = LeaveAsk(key, held.opening)
		return false
	}

	fun stay() {
		leaving.value = null
	}

	/** Busy returns null; `opening` fences settlement. */
	suspend fun send(key: AutomationDraftKey, deleting: Boolean, op: suspend (AutomationDraft) -> AutomationSaved): AutomationOutcome? {
		val before = drafts.getAndUpdate { held ->
			val now = held[key]
			if (now == null || now.busy) held else held + (key to now.copy(busy = true))
		}
		val sent = before[key]?.takeIf { !it.busy } ?: return null
		var outcome: AutomationOutcome? = null
		try {
			outcome = outcomeOf(op(sent.draft), sent.draft, deleting)
		} finally {
			var settled = false
			drafts.update { held ->
				settled = held[key]?.opening == sent.opening
				if (!settled) return@update held
				when (val result = outcome) {
					AutomationOutcome.Done -> held - key
					is AutomationOutcome.Offer -> {
						// A delete's offer is the held row, not an edit.
						val opened = if (deleting) result.draft else sent.opened
						held + (key to sent.copy(draft = result.draft, opened = opened, said = result.line, busy = false))
					}
					is AutomationOutcome.Said -> held + (key to sent.copy(said = result.reason, busy = false))
					null -> held + (key to sent.copy(busy = false))
				}
			}
			if (settled && outcome == AutomationOutcome.Done) {
				landed.update { it + (key to sent.opening) }
				leaving.update { if (it?.key == key) null else it }
			}
		}
		return outcome
	}

	fun toggleRefusalFor(gatewayId: String, automationId: String): String? =
		toggleRefusals.value[gatewayId to automationId]

	suspend fun refreshAll() {
		coroutineScope { state.value.gateways.ids().map { id -> async { refresh(id) } }.awaitAll() }
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val read = reads.read(gatewayId) { attempt { client.list(gatewayId) } ?: AutomationListAnswer.Unreachable }
		if (read !is GatewayRead.Fresh) return
		when (val answer = read.value) {
			is AutomationListAnswer.Listed -> show(gatewayId, answer.automations)
			AutomationListAnswer.Refused -> hide(gatewayId)
			AutomationListAnswer.Unreachable -> Unit
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
		return AutomationSaved.Refused(deleted.reason ?: "This Gateway kept it", state.value.gateways.automationOn(gatewayId, id))
	}

	suspend fun setEnabled(gatewayId: String, row: AutomationRow, enabled: Boolean): AutomationSaved {
		val key = gatewayId to row.id
		var answer: AutomationSaved = AutomationSaved.Unreachable
		val current = toggles.read("$gatewayId/${row.id}") {
			answer = if (gatewayId.isBlank()) {
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
		if (current is GatewayRead.Fresh) {
			noteToggle(
				key,
				when (val result = answer) {
					is AutomationSaved.Stored -> null
					is AutomationSaved.Refused -> result.reason
					AutomationSaved.Unreachable -> GATEWAY_UNREACHABLE
				},
			)
		}
		return answer
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

	private fun noteToggle(key: Pair<String, String>, reason: String?) {
		toggleRefusals.value = if (reason == null) toggleRefusals.value - key else toggleRefusals.value + (key to reason)
	}

	private fun show(gatewayId: String, automations: List<AutomationRow>) {
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(automations = automations) }) }
	}

	private fun hide(gatewayId: String) {
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(automations = null) }) }
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (e: CancellationException) {
		throw e
	} catch (e: Exception) {
		DebugLog.log("Automation", "gateway call failed: ${e::class.simpleName}")
		null
	}
}
