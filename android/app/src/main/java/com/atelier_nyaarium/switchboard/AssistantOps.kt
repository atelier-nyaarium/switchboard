package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.field
import com.atelier_nyaarium.switchboard.assistant.fieldLabel
import com.atelier_nyaarium.switchboard.assistant.label
import com.atelier_nyaarium.switchboard.assistant.carriedFunctionsOf
import com.atelier_nyaarium.switchboard.assistant.FunctionsServed
import com.atelier_nyaarium.switchboard.assistant.actionLabelOn
import com.atelier_nyaarium.switchboard.assistant.carriesFunctions
import com.atelier_nyaarium.switchboard.assistant.carryRefusal
import com.atelier_nyaarium.switchboard.assistant.functionsServed
import com.atelier_nyaarium.switchboard.assistant.functionsServedBy
import com.atelier_nyaarium.switchboard.assistant.UnfollowedCall
import com.atelier_nyaarium.switchboard.assistant.WalkAction
import com.atelier_nyaarium.switchboard.assistant.WalkStep
import com.atelier_nyaarium.switchboard.assistant.reached
import com.atelier_nyaarium.switchboard.assistant.sealedRefusal
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarried
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarriedIntegration
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarriedWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeSealed
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.CarriedAutomation
import com.atelier_nyaarium.switchboard.proto.CarriedFunction
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
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

	/** Old home's list. */
	suspend fun automations(gatewayId: String): ListAnswer<AutomationRow>

	/** With its functions, from one read. */
	suspend fun automationListing(gatewayId: String): AutomationListing = AutomationListing(automations(gatewayId))
}

internal interface AssistantHost {
	val gateway: AssistantGateway?
	/** Null before the federation is reachable. */
	val homeRouter: AssistantHomeRouter?
	fun persistRoles()
	fun persistHome(home: AssistantHome.Read)
}

/** The one reader of a Gateway's sources. */
internal fun sourcesOf(state: ConsoleAssistantStateResult): List<AssistantSource> =
	state.sources ?: state.watchers.orEmpty().map { it.toSource() }

// skew:watchers-field: an older Gateway's watchers.
private fun AssistantWatcher.toSource(): AssistantSource = AssistantSource(
	id = id,
	label = label,
	grants = grants,
	unread = unread,
	capped = capped,
	lastSuccessAt = lastSuccessAt,
	nextPollAt = nextPollAt,
	backoff = backoff,
	stopped = stopped,
	fieldSpecs = fieldSpecs?.takeIf { it.isNotEmpty() }
		?: fields.orEmpty().map { AssistantFieldSpec.Text(field = it, label = fieldLabel(it)) },
	unexpected = unexpected,
	secret = secret,
	actions = actions.orEmpty(),
	enabled = enabled != false,
	triggers = id != "sensors",
)

// skew:automation-serves: the not-served token says what a Gateway serves.
/** An older build answers `watchers` alone. */
internal fun servesSources(state: ConsoleAssistantStateResult?): Boolean = state?.sources != null

/** Unread or refused reads as an older build. */
internal fun servesSources(read: AssistantRead): Boolean = when (read) {
	is AssistantRead.Answered -> servesSources(read.state)
	AssistantRead.Reading, AssistantRead.Refused -> false
}

/** Only a state answered without sources. */
internal fun saysOlderBuild(read: AssistantRead): Boolean = when (read) {
	is AssistantRead.Answered -> !servesSources(read.state)
	AssistantRead.Reading, AssistantRead.Refused -> false
}

private val NO_RULES = AssistantWatcherRules(emptyList(), AssistantRuleOtherwise("inbox", 0L), 0L)

// skew:stored-rules: an older Gateway reads rules.
/** Unconditioned automation is the fallback. */
internal fun rulesOf(sourceId: String, events: List<AutomationRow>): AssistantWatcherRules {
	val waking = events.mapNotNull { row ->
		val trigger = row.automation.trigger as? AutomationTrigger.Event
		val wakes = row.automation.enabled && row.invalid == null &&
			reached(row.automation).any { entry ->
				when (entry) {
					is WalkAction -> (entry.action as? AutomationAction.TellAssistant)?.`when` == "now"
					is WalkStep, is UnfollowedCall -> false
				}
			}
		trigger?.takeIf { it.source == sourceId && wakes }?.let { row.id to it.conditions }
	}
	val rules = waking.filter { it.second.isNotEmpty() }.take(Protocol.Wire.ASSISTANT_RULES_MAX).map { (id, conditions) ->
		AssistantRule(id, conditions.map { AssistantRuleCondition(it.field, it.test, it.value) }, "wake", 0L)
	}
	val otherwise = if (waking.any { it.second.isEmpty() }) "wake" else "inbox"
	return AssistantWatcherRules(rules, AssistantRuleOtherwise(otherwise, 0L), 0L)
}

/** Move payload; null `automations` lists none. */
internal fun carriedOf(
	state: ConsoleAssistantStateResult,
	automations: List<AutomationRow>?,
	functions: List<AutomationFunctionRow>? = null,
): AssistantHomeCarried {
	val events = automations?.filter { it.automation.trigger is AutomationTrigger.Event }
	val carried = events?.map { CarriedAutomation(it.id, it.automation) }
	// skew:stored-rules: an older Gateway's rules.
	val held = state.watchers.orEmpty().associate { it.id to it.rules }
	return AssistantHomeCarried(
		approveEverySend = state.approveEverySend ?: true,
		// An older Gateway refuses null.
		temperatureUnit = state.temperatureUnit ?: "C",
		watchers = sourcesOf(state).map { source ->
			AssistantHomeCarriedWatcher(
				id = source.id,
				// Never null: an older Gateway refuses one.
				rules = events?.let { rulesOf(source.id, it) } ?: held[source.id] ?: NO_RULES,
				grant = source.grants.firstOrNull(),
				enabled = source.enabled,
			)
		},
		automations = carried,
		integrations = state.integrations?.map { integration ->
			AssistantHomeCarriedIntegration(id = integration.id, grant = integration.grants.firstOrNull())
		},
		// None carried sends none.
		functions = carried?.let { moving ->
			carriedFunctionsOf(moving, functions.orEmpty().map { CarriedFunction(it.id, it.function) })
		}?.takeIf { it.isNotEmpty() },
	)
}

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

/** What a placement is measured against. */
internal sealed interface LocationBase {
	/** No move in place. */
	data class Unread(val home: String, val read: AssistantRead) : LocationBase

	data class Known(val workdir: String?) : LocationBase
}

/** `read` is the home's; no home places fresh. */
internal fun locationBase(home: String?, read: AssistantRead?): LocationBase =
	if (home == null) LocationBase.Known(null)
	else when (read) {
		is AssistantRead.Answered -> LocationBase.Known(read.state.workdir)
		AssistantRead.Reading, null -> LocationBase.Unread(home, AssistantRead.Reading)
		AssistantRead.Refused -> LocationBase.Unread(home, AssistantRead.Refused)
	}

/** An unread home shows no folder. */
internal fun folderShown(base: LocationBase, target: String?): Boolean = when (base) {
	is LocationBase.Unread -> target != base.home
	is LocationBase.Known -> true
}

/** Untouched follows the answer. */
internal fun folderAfter(held: String, touched: Boolean, answered: String): String = if (touched) held else answered

/** What the location button does. */
internal sealed interface LocationAction {
	/** Grey: incomplete or unchanged. */
	data object None : LocationAction

	/** Grey; target offline. */
	data class Offline(val gatewayId: String) : LocationAction

	/** `abandoning`: offline home, confirmed first. */
	data class Move(val target: String, val abandoning: String?) : LocationAction
}

internal fun locationAction(registry: GatewayRegistry, home: String?, target: String?, folder: String, base: LocationBase): LocationAction {
	if (target == null || folder.isBlank()) return LocationAction.None
	if (!registry.reachable(target)) return LocationAction.Offline(target)
	val moves = when (base) {
		// Unread: only away.
		is LocationBase.Unread -> target != base.home
		is LocationBase.Known -> placementMoves(home, target, folder, base.workdir)
	}
	return if (moves) LocationAction.Move(target, home?.takeIf { it != target && !registry.reachable(it) }) else LocationAction.None
}

/** Grant or Safety status; null when it landed. */
internal fun answerText(answer: AssistantAnswer): String? = when (answer) {
	is AssistantAnswer.State -> null
	is AssistantAnswer.Refused -> answer.reason
	AssistantAnswer.Unreachable -> "That Gateway could not be reached"
}

internal fun sourceOn(source: AssistantSource): Boolean = source.enabled

/** Inbox strip row. */
internal sealed interface InboxRow {
	val sourceId: String
	val label: String

	/** Check now nudges. */
	data class Waiting(override val sourceId: String, override val label: String, val badge: String) : InboxRow

	/** Settings opens its page. */
	data class Problem(override val sourceId: String, override val label: String) : InboxRow
}

/** Enabled sources needing attention. */
internal fun inboxRows(sources: List<AssistantSource>): List<InboxRow> = sources.filter(::sourceOn).mapNotNull { source ->
	when (val status = sourceStatus(source)) {
		SourceStatus.NeedsSecret, is SourceStatus.Stopped -> InboxRow.Problem(source.id, source.label)
		SourceStatus.NotChecked -> null
		is SourceStatus.Waiting -> if (status.checkedAt != null && source.unread > 0) waiting(source) else null
		is SourceStatus.Checked -> if (source.unread > 0) waiting(source) else null
	}
}

private fun waiting(source: AssistantSource) = InboxRow.Waiting(source.id, source.label, "${countText(source)} new")

/** "+" when capped. */
private fun countText(source: AssistantSource): String = "${source.unread}${if (source.capped == true) "+" else ""}"

internal fun unreadText(source: AssistantSource): String = "${countText(source)} in its inbox"

/** "14", or "500+" when capped. */
internal fun inboxCount(source: AssistantSource): String = countText(source)

/** Needs a secret or stopped. */
internal fun sourceTroubled(source: AssistantSource): Boolean =
	sourceStatus(source).let { it == SourceStatus.NeedsSecret || it is SourceStatus.Stopped }

/** Chip and health agree. */
internal sealed interface SourceStatus {
	/** Hides time and unread. */
	data object NeedsSecret : SourceStatus

	data class Stopped(val reason: String) : SourceStatus

	data class Waiting(val reason: String, val checkedAt: Long?) : SourceStatus

	data object NotChecked : SourceStatus

	data class Checked(val at: Long) : SourceStatus
}

internal fun sourceStatus(source: AssistantSource): SourceStatus = when {
	source.secret != null && source.grants.isEmpty() -> SourceStatus.NeedsSecret
	source.stopped != null -> SourceStatus.Stopped(source.stopped)
	source.backoff != null -> SourceStatus.Waiting(source.backoff.reason, source.lastSuccessAt)
	source.lastSuccessAt == null -> SourceStatus.NotChecked
	else -> SourceStatus.Checked(source.lastSuccessAt)
}

internal fun sourceHealth(source: AssistantSource, ago: (Long) -> String): String = when (val status = sourceStatus(source)) {
	SourceStatus.NeedsSecret -> "Needs a secret"
	is SourceStatus.Stopped -> "Stopped: ${status.reason}"
	is SourceStatus.Waiting ->
		"Waiting: ${status.reason}" + if (status.checkedAt != null) " · ${unreadText(source)}" else ""
	SourceStatus.NotChecked -> "Not checked yet"
	is SourceStatus.Checked -> "Checked ${ago(status.at)} · ${unreadText(source)}"
}

/** Show unlisted event values individually as specs grow. */
internal fun unexpectedLines(source: AssistantSource): List<String> {
	val seen = source.unexpected ?: return emptyList()
	val specs = source.fieldSpecs
	val named = seen.values.map { entry ->
		val field = specs.find { it.field == entry.field }?.label ?: fieldLabel(entry.field)
		"$field: ${entry.value}"
	}
	return if (seen.capped) named + "and more" else named
}

internal enum class AssistantSection { LOCATION, FEATURES, SAFETY, REMOVE }

/** Unread Safety stays, saying why. */
internal fun assistantSections(home: String?, read: AssistantRead?): List<AssistantSection> =
	listOfNotNull(
		AssistantSection.LOCATION,
		AssistantSection.FEATURES,
		AssistantSection.SAFETY.takeIf { home != null && holdsSafety(read) },
		AssistantSection.REMOVE.takeIf { home != null },
	)

/** An older build holds no Safety. */
private fun holdsSafety(read: AssistantRead?): Boolean = when (read) {
	is AssistantRead.Answered -> read.state.approveEverySend != null
	AssistantRead.Reading, AssistantRead.Refused -> true
	null -> false
}

/** Unread names no folder; a late answer reseeds. */
internal fun workdirOf(read: AssistantRead?): String? = when (read) {
	is AssistantRead.Answered -> read.state.workdir
	null, AssistantRead.Reading, AssistantRead.Refused -> null
}

/** Page operation and result. */
internal data class PageWork(val busy: Boolean = false, val said: String? = null)

/** Whose op it is. */
internal sealed interface WorkKey {
	data object Settings : WorkKey

	data object Location : WorkKey

	data object Safety : WorkKey

	data object Units : WorkKey

	data class Source(val gatewayId: String, val sourceId: String) : WorkKey

	/** The strip's Check now. */
	data class Check(val gatewayId: String, val sourceId: String) : WorkKey
}

/** A stopped source that holds its secret can be asked again, as after a rotated key. */
internal fun canRetry(source: AssistantSource): Boolean =
	source.enabled && source.stopped != null && source.grants.isNotEmpty()

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

	private val sourcesMovedFlow = MutableStateFlow(0L)

	/** A shown Assistant re-reads on each bump. */
	val sourcesMoved: StateFlow<Long> = sourcesMovedFlow

	/** The Gateway's quiet row. */
	fun sourcesChanged() {
		sourcesMovedFlow.update { it + 1 }
	}

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
			AssistantAnswer.Unreachable -> fence.land(ticket, HomeEffect.Word(gatewayId, AssistantWord.Unreachable))
			null -> if (read is GatewayRead.Fresh) fence.land(ticket, HomeEffect.Word(gatewayId, AssistantWord.Unreachable))
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
		if (carriesFunctions(carried)) {
			val labels: (String) -> String? = home?.let { actionLabelOn(state.value.gateways, state.value.assistantHome, it) } ?: { _ -> null }
			carryRefusal(carried, servedAt(target), labels)?.let { return@owned failed(ticket, carryRefusalLine(it)) }
		}
		put(ticket, base, target, AssistantHomeSealed(workdirPath = workdir, carried = carried))
	}

	/** Registry, else read now. */
	private suspend fun servedAt(target: String): FunctionsServed {
		val held = state.value
		return when (val known = functionsServed(held.gateways, held.assistantHome, target)) {
			is FunctionsServed.Serves, FunctionsServed.None -> known
			FunctionsServed.Reading, FunctionsServed.Unreachable -> {
				val client = host.gateway ?: return known
				functionsServedBy(attempt { client.automationListing(target) })
			}
		}
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
		envelope?.let(::sealedRefusal)?.let { return failed(ticket, carryRefusalLine(it)) }
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
		val listed = eventRows(client, gatewayId, answer.state) ?: return null
		return carriedOf(answer.state, listed.rows, listed.functions)
	}

	/** `rows` null from a build that lists none. */
	private class EventRows(val rows: List<AutomationRow>?, val functions: List<AutomationFunctionRow>? = null)

	/** Null when unread; a refusal counts only from an older build. */
	private suspend fun eventRows(client: AssistantGateway, gatewayId: String, held: ConsoleAssistantStateResult): EventRows? {
		val listing = attempt { client.automationListing(gatewayId) }
		return when (val listed = listing?.rows) {
			is ListAnswer.Listed -> EventRows(listed.rows, listing.functions)
			ListAnswer.NotServed -> EventRows(null).takeUnless { servesSources(held) }
			ListAnswer.Unreachable, null -> null
		}
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
			val listed = eventRows(client, choice.gatewayId, choice.state) ?: return
			writes.withLock {
				val now = state.value.gateways
				if (!fence.current(ticket) || !now.current || seenAt(now) != asked) return@withLock
				val carried = carriedOf(choice.state, listed.rows, listed.functions)
				put(ticket, 0L, choice.gatewayId, AssistantHomeSealed(workdirPath = choice.workdir, carried = carried))
			}
		} finally {
			seeding.set(false)
		}
	}

	/** An unregistered Gateway never held it; a restart moves its incarnation. */
	private fun seenAt(registry: GatewayRegistry): List<Pair<String, Long>> =
		registry.gateways.filter { it.seen }.map { it.id to it.incarnation }

	suspend fun setSafety(gatewayId: String, approveEverySend: Boolean): AssistantAnswer =
		carriedSetting(gatewayId, ConsoleOp.AssistantSafety(approveEverySend))

	suspend fun setTemperatureUnit(gatewayId: String, unit: String): AssistantAnswer =
		carriedSetting(gatewayId, ConsoleOp.AssistantTemperatureUnit(unit))

	// skew:watcher-kinds: an older build knows the watcher kinds alone.
	private fun sourceOp(gatewayId: String, source: ConsoleOp, watcher: ConsoleOp): ConsoleOp =
		if (servesSources(state.value.gateways.assistantRead(gatewayId))) source else watcher

	suspend fun setGrants(gatewayId: String, sourceId: String, entryIds: List<String>): AssistantAnswer = carriedSetting(
		gatewayId,
		sourceOp(
			gatewayId,
			ConsoleOp.AssistantSourceGrants(sourceId = sourceId, entryIds = entryIds),
			ConsoleOp.AssistantWatcherGrants(watcherId = sourceId, entryIds = entryIds),
		),
	)

	/** The same set again, which the Gateway reads as a poll now. */
	suspend fun retry(gatewayId: String, source: AssistantSource): AssistantAnswer =
		setGrants(gatewayId, source.id, source.grants)

	suspend fun setEnabled(gatewayId: String, sourceId: String, enabled: Boolean): AssistantAnswer = carriedSetting(
		gatewayId,
		sourceOp(
			gatewayId,
			ConsoleOp.AssistantSourceEnabled(sourceId = sourceId, enabled = enabled),
			ConsoleOp.AssistantWatcherEnabled(watcherId = sourceId, enabled = enabled),
		),
	)

	/** Under `writes`, so a move seals it or the old home refuses it. */
	private suspend fun carriedSetting(gatewayId: String, op: ConsoleOp): AssistantAnswer =
		writes.withLock { landed(gatewayId, op) }

	/** Under `writes`; false once the home left. */
	suspend fun carriedWrite(gatewayId: String, write: suspend () -> Unit): Boolean = writes.withLock {
		val home = assistantGateway(state.value)
		if (home != null && home != gatewayId) return@withLock false
		write()
		true
	}

	suspend fun checkNow(gatewayId: String, sourceId: String): AssistantAnswer =
		landed(
			gatewayId,
			sourceOp(gatewayId, ConsoleOp.AssistantSourceCheck(sourceId = sourceId), ConsoleOp.AssistantWatcherCheck(watcherId = sourceId)),
		)

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

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt("Assistant", call)
}
