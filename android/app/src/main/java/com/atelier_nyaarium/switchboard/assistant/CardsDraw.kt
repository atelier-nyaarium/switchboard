package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol

internal sealed interface CardRow {
	val rowKey: String
	val depth: Int

	data class Card(
		val step: StepDraft,
		override val depth: Int,
		val path: String,
		val issue: String?,
		val last: AutomationLastStep?,
		val active: Boolean,
	) : CardRow {
		override val rowKey: String get() = step.key
	}

	data class SideLabel(val parent: String, val side: Side, override val depth: Int) : CardRow {
		override val rowKey: String get() = "$parent/${side.name}"
	}

	/** Full when insertion fails. */
	data class AddSlot(val slot: Slot, override val depth: Int, val full: Boolean) : CardRow {
		override val rowKey: String get() = "${slot.parent ?: "top"}/${slot.side?.name ?: ""}/add"
	}
}

/** Paths under function calls. */
internal fun runPathOf(path: String, pointing: Boolean): String = if (pointing) "0.$path" else path

/** Cards in written order. */
internal fun cardsDraw(
	steps: List<StepDraft>,
	issueOf: (StepDraft) -> String?,
	lastRun: AutomationLastRun?,
	pointing: Boolean,
): List<CardRow> {
	val last = lastRun?.steps.orEmpty().associateBy { it.path }
	val active = lastRun?.active
	fun full(slot: Slot) = insertedStep(steps, slot, StepDraft.Exit("probe")) == null
	fun rows(list: List<StepDraft>, base: String?, depth: Int): List<CardRow> =
		list.withIndex().flatMap { (index, step) ->
			val path = if (base == null) "$index" else "$base.$index"
			val run = runPathOf(path, pointing)
			val card = CardRow.Card(step, depth, path, issueOf(step), last[run], run == active)
			listOf(card) + sidesOf(step).flatMap { (inner, held) ->
				val label = if (inner == Side.ELSE || inner == Side.CATCH) listOf(CardRow.SideLabel(step.key, inner, depth + 1)) else emptyList()
				val slot = Slot(step.key, inner, held.size)
				label + rows(held, "$path.${inner.number}", depth + 1) + CardRow.AddSlot(slot, depth + 1, full(slot))
			}
		}
	val top = Slot(null, null, steps.size)
	return rows(steps, null, 0) + CardRow.AddSlot(top, 0, full(top))
}

internal data class StatementOffer(val kind: String, val label: String)

private val STATEMENTS = listOf("if" to "If", "try" to "Try", "wait" to "Wait", "exit" to "Stop here", "note" to "Note", "call" to "Call")

private const val FRESH_WAIT_MIN = "5"

/** Catch error variable. */
private const val FAILURE_NAME = "e"

/** Statements this Gateway supports. */
internal fun statementsOffered(draft: AutomationDraft, offer: AutomationOffer): List<StatementOffer> {
	val served = offer.functions?.served?.statements.orEmpty()
	if (!unnamedServed(offer) && draft.runs !is RunsHead.Points) return emptyList()
	return STATEMENTS.filter { (kind, _) -> kind in served }.map { (kind, label) -> StatementOffer(kind, label) }
}

internal fun freshStatement(kind: String): StepDraft? = when (kind) {
	"if" -> StepDraft.If(freshKey(), "", emptyList(), emptyList())
	"try" -> StepDraft.Try(freshKey(), emptyList(), emptyList())
	"wait" -> StepDraft.Wait(freshKey(), FRESH_WAIT_MIN)
	"exit" -> StepDraft.Exit(freshKey())
	"note" -> StepDraft.Note(freshKey(), "")
	"call" -> StepDraft.Call(freshKey(), "", emptyMap())
	else -> null
}

/** Flat cap limits actions. */
internal data class SlotOffers(val actions: List<ActionOffer>, val statements: List<StatementOffer>) {
	val empty: Boolean get() = actions.isEmpty() && statements.isEmpty()
}

internal fun slotOffers(draft: AutomationDraft, offer: AutomationOffer, slot: CardRow.AddSlot): SlotOffers {
	if (slot.full) return SlotOffers(emptyList(), emptyList())
	val plainOnly = offer.functions == null || (!unnamedServed(offer) && draft.runs is RunsHead.Own)
	val capped = plainOnly && draft.steps.size >= MAX_ACTIONS
	val actions = if (capped) emptyList() else offer.actions.filter { freshAction(it.kind, offer) != null }
	return SlotOffers(actions, statementsOffered(draft, offer))
}

/** Kept values; catch failure. */
internal fun runNamesOf(steps: List<StepDraft>): List<String> {
	val kept = everyStep(steps).mapNotNull { ((it as? StepDraft.Kept)?.step as? FunctionStep.Let)?.name }.distinct()
	return kept.filter { it != FAILURE_NAME }.take(Protocol.Wire.RUN_NAMES_MAX - 1) + FAILURE_NAME
}

/** Unserved statements disable editing. */
internal fun holdsUnserved(steps: List<StepDraft>, offer: AutomationOffer): Boolean {
	val functions = offer.functions ?: return false
	val served = functions.served.statements.orEmpty()
	return everyStep(steps).any { step -> statementKind(step)?.let { it !in served } == true }
}

private fun statementKind(step: StepDraft): String? = when (step) {
	is StepDraft.If -> "if"
	is StepDraft.Try -> "try"
	is StepDraft.Wait -> "wait"
	is StepDraft.Exit -> "exit"
	is StepDraft.Note -> "note"
	is StepDraft.Call -> "call"
	is StepDraft.Do, is StepDraft.Kept -> null
}

internal fun conditionAsk(
	trigger: AutomationTrigger?,
	condition: String,
	scope: FunctionPreviewScope?,
	steps: List<StepDraft>,
): ConsoleOp.AutomationPreview? =
	condition.takeIf { it.isNotBlank() }?.let { previewAsk(trigger, null, scope, it, runNamesOf(steps)) }

internal sealed interface ConditionPreview {
	/** Blank or no trigger. */
	data object Plain : ConditionPreview

	data object Asking : ConditionPreview

	data object Unread : ConditionPreview

	data class Holds(val holds: Boolean) : ConditionPreview

	/** Runtime value or nonboolean. */
	data class CannotTell(val why: String) : ConditionPreview

	data class Refused(val line: String, val start: Int, val end: Int) : ConditionPreview
}

internal fun conditionPreviewOf(condition: String, asked: Boolean, read: PreviewRead): ConditionPreview {
	val answer = read.answer
	val said = answer?.condition
	return when {
		!asked || condition.isBlank() -> ConditionPreview.Plain
		read.failed -> ConditionPreview.Unread
		answer == null -> ConditionPreview.Asking
		said == null -> ConditionPreview.Unread
		said.issue != null -> said.issue.let { ConditionPreview.Refused(it.message, it.start.toInt(), it.end.toInt()) }
		said.holds != null -> ConditionPreview.Holds(said.holds)
		said.unread != null -> ConditionPreview.CannotTell(said.unread)
		else -> ConditionPreview.Unread
	}
}

/** Only for unchanged drafts. */
internal fun lastRunShown(draft: AutomationDraft, opened: AutomationDraft, row: AutomationRow?, functions: FunctionOffer?): AutomationLastRun? {
	val run = row?.lastRun ?: return null
	// The Gateway serves it for what is stored; the editor must still show that.
	if (row.revision != opened.revision || draft.copy(enabled = opened.enabled).changedFrom(opened)) return null
	val pointing = opened.runsDraft() as? RunsDraft.Pointing
	if (pointing != null && functions?.row(pointing.functionId)?.revision != pointing.base) return null
	return run
}

internal fun lastStepLine(card: CardRow.Card, running: Boolean): String? {
	val step = card.last
	if (card.active && running) return "Running now"
	if (step == null) return null
	val reason = step.reason?.let { ": $it" }.orEmpty()
	return when (Protocol.Wire.RunOutcome.entries.find { it.wire == step.outcome }) {
		null -> if (step.outcome == null) "Started" else "Last run: ${step.outcome}$reason"
		Protocol.Wire.RunOutcome.RAN -> when (step.side) {
			"then" -> "Last run: it held"
			"else" -> "Last run: it did not hold"
			else -> "Last run: done"
		}
		Protocol.Wire.RunOutcome.REFUSED -> "Last run: failed$reason"
		Protocol.Wire.RunOutcome.UNCERTAIN -> "Last run: unsure$reason"
		Protocol.Wire.RunOutcome.SUPPRESSED -> "Last run: skipped$reason"
	}
}

/** Hide issues while blank. */
internal fun cardHint(step: StepDraft, offer: AutomationOffer, valueNames: Set<String>, calleeParams: CalleeParams): String? = when (step) {
	is StepDraft.Do -> actionHint(step.action, offer, valueNames)
	is StepDraft.Wait -> step.minutes.takeIf { it.isNotBlank() }?.let(::waitIssue)
	is StepDraft.Call -> callValueIssue(step, calleeParams)
	is StepDraft.If, is StepDraft.Try, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Kept -> null
}

internal fun waitIssue(typed: String): String? {
	val minutes = parseDecimal(typed.trim()) ?: return "Minutes as a number"
	return "From 0 to ${Protocol.Wire.WAIT_MINUTES_MAX} minutes".takeIf { minutes < 0 || minutes > Protocol.Wire.WAIT_MINUTES_MAX }
}

internal sealed interface CallChoice {
	data class Existing(val id: String, val name: String) : CallChoice

	data object New : CallChoice
}

internal fun functionHere(draft: AutomationDraft, tree: String?): String? =
	tree ?: (draft.runs as? RunsHead.Points)?.pointing?.functionId ?: draft.newFunctionId

/** Exclude recursive callees. */
internal fun callChoices(draft: AutomationDraft, offer: AutomationOffer, tree: String?): List<CallChoice> {
	val here = functionHere(draft, tree)
	val listed = offer.functions?.rows.orEmpty().filter { it.function.name.isNotBlank() }.map { it.id to it.function.name }
	val made = draft.callees.values.filter { it.base == 0L && it.name.isNotBlank() }.map { it.id to it.name }
	val open = (listed + made).distinctBy { it.first }.filter { (id, _) ->
		here == null || here !in draft.reached(listOf(id), offer)
	}
	return open.map { (id, name) -> CallChoice.Existing(id, name) } + CallChoice.New
}

internal fun calleeParams(draft: AutomationDraft, offer: AutomationOffer, id: String): List<FunctionParam>? =
	functionSource(draft, offer, id)?.params

/** Calls read caller names. */
internal fun callNames(draft: AutomationDraft, offer: AutomationOffer, tree: String?, key: String): List<String> {
	val values = if (tree == null) (draft.runs as? RunsHead.Points)?.pointing?.params.orEmpty() else draft.callees[tree]?.params.orEmpty()
	val trigger = offer.names(draft.trigger.kind).map { it.name }
	return (trigger + values.map { it.param.name }.filter { it.isNotBlank() } + runNamesHere(draft.stepsOf(tree), key).map { it.name }).distinct()
}

/** Preview uses tree scope. */
internal fun scopeAt(draft: AutomationDraft, key: String): FunctionPreviewScope? =
	draft.treeHolding(key)?.let { draft.callees[it] }?.let(::calleePreviewScope) ?: functionPreviewScopeOf(draft.runsDraft())

internal fun namesAt(draft: AutomationDraft, offer: AutomationOffer, key: String, answered: List<AutomationPreviewName>?): List<NameHere> {
	val callee = draft.treeHolding(key)?.let { draft.callees[it] }
	if (callee != null) return namesHere(offer, draft.trigger.kind, answered, callee.params.map { it.param })
	val pointing = draft.runsDraft() as? RunsDraft.Pointing
	return namesHere(offer, draft.trigger.kind, answered, pointing?.wireParams().orEmpty(), pointing?.valuesByName().orEmpty())
}

internal sealed interface CallLine {
	/** Reload re-reads `id`. */
	data class Moved(val id: String) : CallLine

	data object Attention : CallLine
}

/** Through its calls too. */
internal fun callLine(draft: AutomationDraft, offer: AutomationOffer, said: AutomationSaid?, function: String): CallLine? {
	if (function.isBlank()) return null
	val below = draft.reached(listOf(function), offer)
	movedCallee(said, draft, offer)?.takeIf { it in below }?.let { return CallLine.Moved(it) }
	val saidKey = when (said) {
		is AutomationSaid.Field -> (said.at as? SaidAt.Card)?.key
		is AutomationSaid.Hole -> said.key
		else -> null
	}
	val saidBelow = saidKey?.let { draft.treeHolding(it) } in below
	val issueBelow = below.any { id ->
		when (val source = functionSource(draft, offer, id)) {
			is FunctionSource.Cards -> source.callee?.let { calleeIssue(it, offer, calleeParamsOf(draft, offer)) } != null
			is FunctionSource.Listed -> source.row.invalid != null
			null -> false
		}
	}
	return CallLine.Attention.takeIf { saidBelow || issueBelow }
}

/** Trigger inputs appear given. */
internal fun callRows(draft: AutomationDraft, offer: AutomationOffer, function: String): List<ValueRow>? {
	val params = calleeParams(draft, offer, function) ?: return null
	return valueRows(params, givenOf(draft, fieldsOf(draft, draft.context.sources)), emptyMap(), measureOf(draft))
}

/** Affected automations' sentences. */
internal fun alsoRunBy(draft: AutomationDraft, offer: AutomationOffer, rows: List<AutomationRow>, function: String): List<String> {
	val functions = offer.functions?.rows.orEmpty()
	val seen = mutableSetOf<String>()
	val queue = ArrayDeque(listOf(function))
	val users = mutableSetOf<String>()
	while (queue.isNotEmpty()) {
		val id = queue.removeFirst()
		if (!seen.add(id)) continue
		val row = functions.firstOrNull { it.id == id } ?: continue
		users += row.users
		queue += row.callers.orEmpty()
	}
	return (users - draft.id).map { id -> rows.firstOrNull { it.id == id }?.sentence ?: id }
}
