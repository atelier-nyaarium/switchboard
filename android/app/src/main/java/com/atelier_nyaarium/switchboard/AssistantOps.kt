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
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarried
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarriedWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeSealed
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The Gateway's mark on the assistant's presence row. */
internal const val ASSISTANT_ROLE = Protocol.Wire.ASSISTANT_ROLE

private const val ROUTER_UNREACHABLE = "could not reach the Federation Router"
private const val NOT_READ = "where the assistant lives has not been read yet"
private const val UNROUTABLE = "unroutable"

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface AssistantGateway {
	suspend fun call(gatewayId: String, op: ConsoleOp): AssistantAnswer

	suspend fun rules(gatewayId: String, op: ConsoleOp): RuleSaved

	/** Null if unanswered. */
	suspend fun preview(gatewayId: String, op: ConsoleOp.AssistantRulesPreview): ConsoleAssistantPreviewResult?
}

internal interface AssistantHost {
	val gateway: AssistantGateway?
	/** Null before the federation is reachable. */
	val homeRouter: AssistantHomeRouter?
	fun persistRoles(roles: Map<String, String>)
	fun persistHome(home: AssistantHome.Read)
}

/** Settings a move carries. */
internal fun carriedOf(state: ConsoleAssistantStateResult): AssistantHomeCarried = AssistantHomeCarried(
	approveEverySend = state.approveEverySend ?: true,
	watchers = state.watchers.mapNotNull { watcher ->
		watcher.rules?.let { AssistantHomeCarriedWatcher(id = watcher.id, rules = it, grant = watcher.grants.firstOrNull()) }
	},
)

/** Sole holder, for seeding. */
internal data class SeedChoice(val gatewayId: String, val workdir: String, val state: ConsoleAssistantStateResult)

/** Every answer, one holder; silence is never "none". */
internal fun seedFrom(answers: List<Pair<String, AssistantAnswer?>>): SeedChoice? {
	if (answers.isEmpty() || answers.any { it.second !is AssistantAnswer.State }) return null
	val holders = answers.mapNotNull { (gatewayId, answer) ->
		val held = (answer as AssistantAnswer.State).state
		held.workdir?.let { SeedChoice(gatewayId, it, held) }
	}
	return holders.singleOrNull()
}

/** Null when older; a repeat keeps its report. */
internal fun newerHome(held: AssistantHome, incoming: AssistantHome.Read): AssistantHome.Read? {
	val kept = held as? AssistantHome.Read ?: return incoming
	val version = incoming.record?.version ?: 0L
	val heldVersion = kept.record?.version ?: 0L
	return when {
		version < heldVersion -> null
		version == heldVersion && incoming.report == null -> incoming.copy(report = kept.report)
		else -> incoming
	}
}

internal fun moveErrorText(reason: String): String = "Error moving assistant: $reason"

/** Put refusal, owner-facing. */
internal fun homeRefusalText(refusal: String?, target: String?): String = when (refusal) {
	UNROUTABLE -> "${target ?: "that Gateway"} can't be reached."
	"too_large" -> "the assistant's settings are too large to move"
	"durability_failure" -> "the Router could not save it"
	"durability_uncertain" -> "the Router could not confirm it"
	null -> "the Router turned it down"
	else -> refusal
}

/** The folder as the Gateway stores it: no trailing slash, the root kept. */
internal fun folderOf(text: String): String = text.trim().trimEnd('/').ifEmpty { "/" }

/** A move does something: another Gateway, or another folder on the same one. */
internal fun placementMoves(home: String?, target: String?, folder: String, workdir: String?): Boolean =
	target != null && (target != home || workdir == null || folderOf(folder) != folderOf(workdir))

/** What the location button does. */
internal sealed interface LocationAction {
	/** Grey: incomplete or unchanged. */
	data object None : LocationAction

	/** Grey; target offline. */
	data class Offline(val gatewayId: String) : LocationAction

	/** `abandoning`: offline home, confirmed first. */
	data class Move(val target: String, val abandoning: String?) : LocationAction
}

internal fun locationAction(registry: GatewayRegistry, home: String?, target: String?, folder: String, workdir: String?): LocationAction =
	when {
		target == null || folder.isBlank() -> LocationAction.None
		!registry.reachable(target) -> LocationAction.Offline(target)
		!placementMoves(home, target, folder, workdir) -> LocationAction.None
		else -> LocationAction.Move(target, home?.takeIf { it != target && !registry.reachable(it) })
	}

/** Grant or Safety status; null when it landed. */
internal fun answerText(answer: AssistantAnswer): String? = when (answer) {
	is AssistantAnswer.State -> null
	is AssistantAnswer.Refused -> answer.reason
	AssistantAnswer.Unreachable -> "That Gateway could not be reached"
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
internal enum class AssistantSection { LIVES_ON, SAFETY, WATCHERS }

/** Safety and watchers are the home's. */
internal fun assistantSections(home: String?, placed: ConsoleAssistantStateResult?): List<AssistantSection> =
	listOfNotNull(
		AssistantSection.LIVES_ON,
		AssistantSection.SAFETY.takeIf { home != null && placed?.approveEverySend != null },
		AssistantSection.WATCHERS.takeIf { home != null && placed != null },
	)

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

/** The home record is held; a Gateway's answer replaces what it last said. */
internal class AssistantOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: AssistantHost,
) {
	private val reads = GatewayReadFence()

	private val fence = AssistantHomeFence(state, host::persistHome, host::persistRoles)

	private val seeding = java.util.concurrent.atomic.AtomicBoolean(false)

	/** Serializes owner writes and seeding. */
	private val writes = Mutex()

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

	/** True once read; an unwritten home may seed. */
	suspend fun readHome(): Boolean {
		if (!fetchHome()) return false
		if (homeUnsettled(state.value)) seed()
		return true
	}

	/** Never seeds, so the drain waits on no Gateway. False when unanswered or stale. */
	suspend fun fetchHome(): Boolean {
		val router = host.homeRouter ?: return false
		val ticket = fence.begin()
		val read = attempt { router.read() } ?: return false
		return fence.land(ticket, HomeEffect.Record(AssistantHome.Read(read.record, read.report))) != HomeLanding.Stale
	}

	/** What a shown Assistant reads: the record while unsettled, then the home's answer. */
	suspend fun refreshShown() {
		if (homeUnsettled(state.value)) readHome()
		refreshHome()
	}

	/** A re-provision; `provision` runs inside the fence, never beside an owner write. */
	suspend fun forgetHome(provision: () -> Unit = {}) = writes.withLock { fence.across(provision) }

	/** Under `writes`, refused when a re-provision ran while it waited. */
	private suspend fun owned(write: suspend (HomeTicket) -> String?): String? {
		val called = fence.begin()
		return writes.withLock {
			val ticket = fence.begin()
			if (ticket.generation == called.generation) write(ticket) else null
		}
	}

	/** Only the home is asked for its state. */
	suspend fun refreshHome() {
		assistantGateway(state.value)?.let { refresh(it) }
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val ticket = fence.begin()
		val read = reads.read(gatewayId) { attempt { client.call(gatewayId, ConsoleOp.AssistantState) } }
		when (val answer = (read as? GatewayRead.Fresh)?.value) {
			is AssistantAnswer.State -> fence.land(ticket, HomeEffect.Word(gatewayId, AssistantWord.Answered(answer.state)))
			// Refusal leaves placement unknown.
			is AssistantAnswer.Refused -> fence.land(ticket, HomeEffect.Word(gatewayId, AssistantWord.Refused))
			AssistantAnswer.Unreachable, null -> {}
		}
	}

	/** Placed: fresh settings. Unplaced: what the record sealed. Offline: none, once confirmed. */
	suspend fun moveAssistant(target: String, workdir: String, abandoning: String? = null): String? = owned { ticket ->
		val base = baseOf(ticket) ?: return@owned failed(ticket, NOT_READ)
		val record = (ticket.held as? AssistantHome.Read)?.record
		val home = record?.gatewayId
		val carried = when {
			home == null -> null
			placedGateway(state.value) != home -> {
				val opened = record?.sealed?.let { host.homeRouter?.open(home, base, it) }
				when {
					opened != null -> opened.carried
					abandoning == home -> null
					else -> return@owned failed(ticket, "could not open the assistant's settings")
				}
			}
			state.value.gateways.reachable(home) ->
				carriedFrom(ticket, home) ?: return@owned failed(ticket, "could not read the assistant's settings on $home")
			abandoning == home -> null
			else -> return@owned failed(ticket, homeRefusalText(UNROUTABLE, home))
		}
		put(ticket, base, target, AssistantHomeSealed(workdirPath = workdir, carried = carried))
	}

	/** Removal needs no key. */
	suspend fun removeAssistant(): String? = owned { ticket ->
		put(ticket, baseOf(ticket) ?: return@owned failed(ticket, NOT_READ), null, null)
	}

	/** Null while unread. */
	private fun baseOf(ticket: HomeTicket): Long? = when (val choice = ticket.choice) {
		HomeChoice.Unread -> null
		HomeChoice.NeverWritten -> 0L
		is HomeChoice.At -> choice.version
	}

	/** A conflict adopts the winner; an unknown outcome is read back. */
	private suspend fun put(ticket: HomeTicket, base: Long, target: String?, sealed: AssistantHomeSealed?): String? {
		val router = host.homeRouter ?: return failed(ticket, ROUTER_UNREACHABLE)
		val envelope = if (target != null && sealed != null) {
			router.seal(target, base + 1, sealed) ?: return failed(ticket, "this phone has no content key yet")
		} else {
			null
		}
		if (!fence.holds(ticket)) return null
		fence.land(ticket, HomeEffect.Failure(null))
		when (val result = attempt { router.put(base, target, envelope) } ?: HomePut.Uncertain(null)) {
			is HomePut.Applied -> return adopt(ticket, result.record)
			is HomePut.Conflict -> return adopt(ticket, result.record)
			is HomePut.Refused -> return failed(ticket, homeRefusalText(result.reason, target))
			is HomePut.Uncertain -> {
				fetchHome()
				val now = (state.value.assistantHome as? AssistantHome.Read)?.record
				if (now != null && now.version == base + 1 && now.gatewayId == target && now.sealed == envelope) return null
				return failed(ticket, result.reason?.let { homeRefusalText(it, target) } ?: ROUTER_UNREACHABLE)
			}
		}
	}

	private suspend fun adopt(ticket: HomeTicket, record: AssistantHomeRecord?): String? {
		fence.land(ticket, HomeEffect.Record(AssistantHome.Read(record, null)))
		// Catch an already filed report.
		fetchHome()
		return null
	}

	/** Null when a newer choice landed first. */
	private fun failed(ticket: HomeTicket, reason: String): String? =
		reason.takeIf { fence.land(ticket, HomeEffect.Failure(reason)) != HomeLanding.Stale }

	private suspend fun carriedFrom(ticket: HomeTicket, gatewayId: String): AssistantHomeCarried? {
		val client = host.gateway ?: return null
		val answer = attempt { client.call(gatewayId, ConsoleOp.AssistantState) } as? AssistantAnswer.State ?: return null
		fence.land(ticket, HomeEffect.Word(gatewayId, AssistantWord.Answered(answer.state)))
		return carriedOf(answer.state)
	}

	/** Fresh answers from the roster as asked; an owner choice wins. */
	private suspend fun seed() {
		val registry = state.value.gateways
		if (!registry.current || !seeding.compareAndSet(false, true)) return
		try {
			val client = host.gateway ?: return
			val ticket = fence.begin()
			if (ticket.choice != HomeChoice.NeverWritten) return
			val asked = seenAt(registry)
			val answers = coroutineScope {
				asked.map { (id, _) -> async { id to attempt { client.call(id, ConsoleOp.AssistantState) } } }.awaitAll()
			}
			val choice = seedFrom(answers) ?: return
			writes.withLock {
				val now = state.value.gateways
				if (!fence.current(ticket) || !now.current || seenAt(now) != asked) return@withLock
				put(ticket, 0L, choice.gatewayId, AssistantHomeSealed(workdirPath = choice.workdir, carried = carriedOf(choice.state)))
			}
		} finally {
			seeding.set(false)
		}
	}

	/** An unregistered Gateway never held it; a restart moves its incarnation. */
	private fun seenAt(registry: GatewayRegistry): List<Pair<String, Long>> =
		registry.gateways.filter { it.seen }.map { it.id to it.incarnation }

	suspend fun setSafety(gatewayId: String, approveEverySend: Boolean): AssistantAnswer =
		landed(gatewayId, ConsoleOp.AssistantSafety(approveEverySend))

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
		val ticket = fence.begin()
		val answer = attempt { client.call(gatewayId, op) } ?: AssistantAnswer.Unreachable
		when (answer) {
			is AssistantAnswer.State ->
				if (reads.read(gatewayId) { answer } is GatewayRead.Fresh) {
					fence.land(ticket, HomeEffect.Word(gatewayId, AssistantWord.Answered(answer.state)))
				}
			is AssistantAnswer.Refused -> refresh(gatewayId)
			AssistantAnswer.Unreachable -> {}
		}
		return answer
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
