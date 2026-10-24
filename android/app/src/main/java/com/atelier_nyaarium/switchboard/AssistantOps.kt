package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleDraft
import com.atelier_nyaarium.switchboard.assistant.RuleEdit
import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.SaveOutcome
import com.atelier_nyaarium.switchboard.assistant.field
import com.atelier_nyaarium.switchboard.assistant.fieldLabel
import com.atelier_nyaarium.switchboard.assistant.label
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.proto.AssistantActionDescriptor
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet

/** The Gateway's mark on the assistant's presence row. */
internal const val ASSISTANT_ROLE = Protocol.Wire.ASSISTANT_ROLE

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface AssistantGateway {
	suspend fun call(gatewayId: String, op: ConsoleOp): AssistantAnswer

	suspend fun rules(gatewayId: String, op: ConsoleOp): RuleSaved

	/** Null if unanswered. */
	suspend fun preview(gatewayId: String, op: ConsoleOp.AssistantRulesPreview): ConsoleAssistantPreviewResult?
}

internal interface AssistantHost {
	val gateway: AssistantGateway?
}

/** What a move did. Placing comes first, so a refused place leaves the old home untouched. */
internal sealed interface AssistantMoved {
	data object Moved : AssistantMoved
	data class Refused(val reason: String) : AssistantMoved
	data object Unreachable : AssistantMoved

	/** Placed, but these Gateways it left did not release. */
	data class StillOn(val gatewayIds: List<String>) : AssistantMoved
}

/** The folder as the Gateway stores it: no trailing slash, the root kept. */
internal fun folderOf(text: String): String = text.trim().trimEnd('/').ifEmpty { "/" }

/** A move does something: another Gateway, or another folder on the same one. */
internal fun placementMoves(home: String?, target: String?, folder: String, workdir: String?): Boolean =
	target != null && (target != home || workdir == null || folderOf(folder) != folderOf(workdir))

/** Grant or release status; null when it landed. */
internal fun answerText(answer: AssistantAnswer): String? = when (answer) {
	is AssistantAnswer.State -> null
	is AssistantAnswer.Refused -> answer.reason
	AssistantAnswer.Unreachable -> "That Gateway could not be reached"
}

/** Move status; null when it landed. */
internal fun movedText(moved: AssistantMoved): String? = when (moved) {
	AssistantMoved.Moved -> null
	is AssistantMoved.Refused -> moved.reason
	AssistantMoved.Unreachable -> "That Gateway could not be reached"
	is AssistantMoved.StillOn ->
		"Placed, but ${moved.gatewayIds.joinToString()} did not confirm it let go. Move again once it answers."
}

/** One chip in the inbox strip. */
internal data class WatcherChip(val text: String, val needsSecret: Boolean)

/** "+" when capped. */
internal fun unreadText(watcher: AssistantWatcher): String =
	"${watcher.unread}${if (watcher.capped == true) "+" else ""} unread"

/** Chip and health agree. */
internal sealed interface WatcherStatus {
	/** Hides time and unread. */
	data object NeedsSecret : WatcherStatus

	data class Stopped(val reason: String) : WatcherStatus

	data class Waiting(val reason: String, val checkedAt: Long?) : WatcherStatus

	data object NotChecked : WatcherStatus

	data class Checked(val at: Long) : WatcherStatus
}

internal fun watcherStatus(watcher: AssistantWatcher): WatcherStatus = when {
	watcher.secret != null && watcher.grants.isEmpty() -> WatcherStatus.NeedsSecret
	watcher.stopped != null -> WatcherStatus.Stopped(watcher.stopped)
	watcher.backoff != null -> WatcherStatus.Waiting(watcher.backoff.reason, watcher.lastSuccessAt)
	watcher.lastSuccessAt == null -> WatcherStatus.NotChecked
	else -> WatcherStatus.Checked(watcher.lastSuccessAt)
}

/** No count before a poll has read one. */
internal fun watcherChip(watcher: AssistantWatcher): WatcherChip {
	val label = watcher.label
	val counted = "$label · ${unreadText(watcher)}"
	return when (val status = watcherStatus(watcher)) {
		WatcherStatus.NeedsSecret -> WatcherChip("$label needs a secret", needsSecret = true)
		is WatcherStatus.Stopped -> WatcherChip("$label stopped", needsSecret = false)
		is WatcherStatus.Waiting -> WatcherChip(if (status.checkedAt == null) "$label not checked yet" else counted, needsSecret = false)
		WatcherStatus.NotChecked -> WatcherChip("$label not checked yet", needsSecret = false)
		is WatcherStatus.Checked -> WatcherChip(counted, needsSecret = false)
	}
}

/** A watcher's settings row. */
internal fun watcherHealth(watcher: AssistantWatcher, ago: (Long) -> String): String = when (val status = watcherStatus(watcher)) {
	WatcherStatus.NeedsSecret -> "Needs a secret"
	is WatcherStatus.Stopped -> "Stopped: ${status.reason}"
	is WatcherStatus.Waiting ->
		"Waiting: ${status.reason}" + if (status.checkedAt != null) " · ${unreadText(watcher)}" else ""
	WatcherStatus.NotChecked -> "Not checked yet"
	is WatcherStatus.Checked -> "Checked ${ago(status.at)} · ${unreadText(watcher)}"
}

/** Show unlisted event values individually as specs grow. */
internal fun unexpectedLines(watcher: AssistantWatcher): List<String> {
	val seen = watcher.unexpected ?: return emptyList()
	val specs = watcher.fieldSpecs.orEmpty()
	val named = seen.values.map { entry ->
		val field = specs.find { it.field == entry.field }?.label ?: fieldLabel(entry.field)
		"$field: ${entry.value}"
	}
	return if (seen.capped) named + "and more" else named
}

/** "4 rules · 1 invalid". */
internal fun rulesCountText(rules: Int, invalid: Int): String {
	val count = if (rules == 1) "1 rule" else "$rules rules"
	return if (invalid == 0) count else "$count · $invalid invalid"
}

/** Lives on comes first. */
internal enum class AssistantSection { LIVES_ON, WATCHERS }

internal fun assistantSections(home: String?, placed: ConsoleAssistantStateResult?): List<AssistantSection> =
	listOfNotNull(AssistantSection.LIVES_ON, AssistantSection.WATCHERS.takeIf { home != null && placed != null })

/** Page operation and result. */
internal data class PageWork(val busy: Boolean = false, val said: String? = null)

/** Whose op it is. */
internal sealed interface WorkKey {
	data object Settings : WorkKey

	data class RuleList(val gatewayId: String, val watcherId: String) : WorkKey
}

internal data class RuleDraftKey(val gatewayId: String, val watcherId: String, val slot: RuleSlot)

/** Opening fences draft settlement. */
internal data class HeldRuleDraft(val draft: RuleDraft, val opening: Long, val said: String? = null, val busy: Boolean = false)

/** Older Gateways name none. */
internal fun watcherActions(watcher: AssistantWatcher): List<AssistantActionDescriptor> = watcher.actions.orEmpty()

/** A stopped watcher that holds its secret can be asked again, as after a rotated key. */
internal fun canRetry(watcher: AssistantWatcher): Boolean = watcher.stopped != null && watcher.grants.isNotEmpty()

/** Nothing is held on the phone; every answer replaces what a Gateway last said. */
internal class AssistantOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: AssistantHost,
) {
	private val reads = GatewayReadFence()

	/** The last move's target. */
	val preferredHome = MutableStateFlow<String?>(null)

	/** Page results survive Back. */
	val work = MutableStateFlow<Map<WorkKey, PageWork>>(emptyMap())

	/** Success or Cancel clears. */
	val ruleDrafts = MutableStateFlow<Map<RuleDraftKey, HeldRuleDraft>>(emptyMap())

	/** Landed opening per key. */
	val ruleLanded = MutableStateFlow<Map<RuleDraftKey, Long>>(emptyMap())

	/** Per-key busy calls drop. */
	suspend fun runWork(key: WorkKey, op: suspend AssistantOps.() -> String?) {
		val held = work.getAndUpdate { if (it[key]?.busy == true) it else it + (key to PageWork(busy = true)) }
		if (held[key]?.busy == true) return
		var said: String? = null
		try {
			said = op()
		} finally {
			work.update { it + (key to PageWork(said = said)) }
		}
	}

	private val openings = java.util.concurrent.atomic.AtomicLong()

	/** No edits while its op is out. */
	fun editRule(key: RuleDraftKey, draft: RuleDraft) {
		ruleDrafts.update { held ->
			val now = held[key]
			if (now?.busy == true) held else held + (key to (now?.copy(draft = draft) ?: HeldRuleDraft(draft, openings.incrementAndGet())))
		}
	}

	/** The opening a send will settle. */
	fun holdRule(key: RuleDraftKey, draft: RuleDraft): Long {
		val minted = openings.incrementAndGet()
		return ruleDrafts.updateAndGet { held -> if (key in held) held else held + (key to HeldRuleDraft(draft, minted)) }
			.getValue(key).opening
	}

	fun cancelRule(key: RuleDraftKey) {
		ruleDrafts.update { it - key }
	}

	/** Busy returns null; sends held or `opened`; `opening` fences settlement. */
	suspend fun sendRule(key: RuleDraftKey, opened: RuleDraft, edit: RuleEdit, op: suspend (RuleDraft) -> RuleSaved): SaveOutcome? {
		val minted = openings.incrementAndGet()
		val before = ruleDrafts.getAndUpdate { held ->
			val now = held[key]
			if (now?.busy == true) held
			else held + (key to HeldRuleDraft(now?.draft ?: opened, now?.opening ?: minted, now?.said, busy = true))
		}
		if (before[key]?.busy == true) return null
		val opening = before[key]?.opening ?: minted
		val draft = before[key]?.draft ?: opened
		var outcome: SaveOutcome? = null
		try {
			outcome = outcomeOf(op(draft), draft, key.slot, edit)
		} finally {
			var settled = false
			ruleDrafts.update { held ->
				settled = held[key]?.opening == opening
				if (!settled) return@update held
				when (val landed = outcome) {
					SaveOutcome.Done -> held - key
					is SaveOutcome.Offer -> held + (key to HeldRuleDraft(landed.draft, opening, landed.line))
					is SaveOutcome.Said -> held + (key to HeldRuleDraft(draft, opening, landed.reason))
					null -> held + (key to HeldRuleDraft(draft, opening))
				}
			}
			if (settled && outcome == SaveOutcome.Done) ruleLanded.update { it + (key to opening) }
		}
		return outcome
	}

	suspend fun refreshAll() {
		coroutineScope { state.value.gateways.ids().map { id -> async { refresh(id) } }.awaitAll() }
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val read = reads.read(gatewayId) { attempt { client.call(gatewayId, ConsoleOp.AssistantState) } }
		when (val answer = (read as? GatewayRead.Fresh)?.value) {
			is AssistantAnswer.State -> show(gatewayId, AssistantWord.Answered(answer.state))
			// Refusal leaves placement unknown.
			is AssistantAnswer.Refused -> show(gatewayId, AssistantWord.Refused)
			AssistantAnswer.Unreachable, null -> {}
		}
	}

	/** Queries other Gateways directly, places, then releases; lists uncertain homes. */
	suspend fun move(target: String, workdir: String): AssistantMoved {
		val client = host.gateway ?: return AssistantMoved.Unreachable
		val others = coroutineScope {
			state.value.gateways.ids().filter { it != target }.map { id ->
				async { id to (attempt { client.call(id, ConsoleOp.AssistantState) } ?: AssistantAnswer.Unreachable) }
			}.awaitAll()
		}
		val leaving = others.filter { (_, answer) -> (answer as? AssistantAnswer.State)?.state?.workdir != null }.map { it.first }
		val unread = others.filter { (_, answer) -> answer !is AssistantAnswer.State }.map { it.first }
		when (val placed = landed(target, ConsoleOp.AssistantPlace(workdir = workdir))) {
			is AssistantAnswer.State -> preferredHome.value = target
			is AssistantAnswer.Refused -> return AssistantMoved.Refused(placed.reason)
			AssistantAnswer.Unreachable -> return AssistantMoved.Unreachable
		}
		val stuck = (leaving.filter { release(it) !is AssistantAnswer.State } + unread).distinct()
		return if (stuck.isEmpty()) AssistantMoved.Moved else AssistantMoved.StillOn(stuck)
	}

	suspend fun release(gatewayId: String): AssistantAnswer = landed(gatewayId, ConsoleOp.AssistantRelease)

	suspend fun setGrants(gatewayId: String, watcherId: String, entryIds: List<String>): AssistantAnswer =
		landed(gatewayId, ConsoleOp.AssistantWatcherGrants(watcherId = watcherId, entryIds = entryIds))

	/** The same set again, which the Gateway reads as a poll now. */
	suspend fun retry(gatewayId: String, watcher: AssistantWatcher): AssistantAnswer =
		setGrants(gatewayId, watcher.id, watcher.grants)

	/** 0 adds the rule. */
	suspend fun saveRule(gatewayId: String, watcherId: String, rule: AssistantRule): RuleSaved =
		ruleOp(gatewayId, ConsoleOp.AssistantRulePut(watcherId = watcherId, rule = rule))

	suspend fun deleteRule(gatewayId: String, watcherId: String, ruleId: String, base: Long): RuleSaved =
		ruleOp(gatewayId, ConsoleOp.AssistantRuleDelete(watcherId = watcherId, ruleId = ruleId, baseRevision = base))

	/** Over the list revision drawn; null moves it last. */
	suspend fun moveRule(gatewayId: String, watcherId: String, ruleId: String, beforeId: String?, base: Long): RuleSaved =
		ruleOp(
			gatewayId,
			ConsoleOp.AssistantRuleMove(watcherId = watcherId, ruleId = ruleId, beforeId = beforeId, baseRevision = base),
		)

	suspend fun saveOtherwise(gatewayId: String, watcherId: String, otherwise: AssistantRuleOtherwise): RuleSaved =
		ruleOp(gatewayId, ConsoleOp.AssistantOtherwisePut(watcherId = watcherId, otherwise = otherwise))

	/** At the held rule's place by id, else last. */
	suspend fun preview(gatewayId: String, watcherId: String, rule: AssistantRule): ConsoleAssistantPreviewResult? {
		val client = host.gateway ?: return null
		return attempt { client.preview(gatewayId, ConsoleOp.AssistantRulesPreview(watcherId = watcherId, rule = rule)) }
	}

	/** A caller decides from the answer; the fenced read after it only draws. */
	private suspend fun ruleOp(gatewayId: String, op: ConsoleOp): RuleSaved {
		val client = host.gateway ?: return RuleSaved.Unreachable
		val answer = attempt { client.rules(gatewayId, op) } ?: RuleSaved.Unreachable
		if (answer !is RuleSaved.Unreachable) refresh(gatewayId)
		return answer
	}

	/** Fenced draw; a refusal re-reads. */
	private suspend fun landed(gatewayId: String, op: ConsoleOp): AssistantAnswer {
		val client = host.gateway ?: return AssistantAnswer.Unreachable
		val answer = attempt { client.call(gatewayId, op) } ?: AssistantAnswer.Unreachable
		when (answer) {
			is AssistantAnswer.State ->
				if (reads.read(gatewayId) { answer } is GatewayRead.Fresh) show(gatewayId, AssistantWord.Answered(answer.state))
			is AssistantAnswer.Refused -> refresh(gatewayId)
			AssistantAnswer.Unreachable -> {}
		}
		return answer
	}

	private fun show(gatewayId: String, word: AssistantWord) {
		state.update { held ->
			held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(assistant = word) }).withoutAssistantTabs()
		}
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (e: CancellationException) {
		throw e
	} catch (e: Exception) {
		DebugLog.log("Assistant", "gateway call failed: ${e.message}")
		null
	}
}
