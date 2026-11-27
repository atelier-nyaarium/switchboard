package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AutomationIssue
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationIssueLevel
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRecord

/** Null means uncaused. */
internal data class CardIssue(val level: AutomationIssueLevel?, val line: String, val chip: String? = null) {
	val text: String get() = chip?.let { "$it: $line" } ?: issueText(line)
}

/** A standalone issue line. */
internal fun issueText(line: String): String = line.replaceFirstChar { it.uppercaseChar() }

internal fun drawsAsError(level: AutomationIssueLevel?): Boolean = when (level) {
	AutomationIssueLevel.UNARMED, AutomationIssueLevel.ERROR -> true
	AutomationIssueLevel.WARNING, null -> false
}

// skew:step-refusals
/** Absent or unknown: error. */
internal fun issueLevelOf(word: String?): AutomationIssueLevel =
	AutomationIssueLevel.entries.find { it.wire == word } ?: AutomationIssueLevel.ERROR

internal data class DrawnIssues(
	val cards: Map<String, CardIssue>,
	val rest: List<CardIssue>,
	val functions: Set<String>,
)

private fun ownIssue(issue: AutomationIssue, draft: AutomationDraft): Boolean =
	issue.record == AutomationSaveRecord.AUTOMATION.wire || issue.id == null || issue.id == functionHere(draft, null)

private fun issueTree(issue: AutomationIssue, draft: AutomationDraft, flat: Boolean): List<StepDraft>? = when (issue.record) {
	AutomationSaveRecord.AUTOMATION.wire -> draft.steps.takeIf { flat }
	else -> draft.cardsOf(issue.id)
}

/** Flat writes omit functions. */
internal fun drawnIssuesOf(issues: List<AutomationIssue>, draft: AutomationDraft, flat: Boolean, offer: AutomationOffer): DrawnIssues {
	val cards = mutableMapOf<String, CardIssue>()
	val rest = mutableListOf<CardIssue>()
	val functions = mutableSetOf<String>()
	for (issue in issues) {
		val level = issueLevelOf(issue.level)
		val other = issue.id?.takeUnless { ownIssue(issue, draft) }
		if (other != null && drawsAsError(level)) functions += other
		val tree = issueTree(issue, draft, flat)
		val key = issue.step?.let { path -> tree?.let { keyAt(it, path) } }
		// Case chips render issues.
		if (issue.case != null && key != null && tree?.let { findStep(it, key) } is StepDraft.Switch) continue
		if (key == null) {
			val named = other?.let { id -> draft.callees[id]?.name ?: offer.functions?.row(id)?.function?.name ?: id }
			rest += CardIssue(level, issue.line, listOfNotNull(named, issue.value).joinToString(": ").ifEmpty { null })
			continue
		}
		val held = cards[key]
		if (held == null || (!drawsAsError(held.level) && drawsAsError(level))) cards[key] = CardIssue(level, issue.line, issue.value)
	}
	return DrawnIssues(cards, rest, functions)
}

internal fun cardIssueOf(step: StepDraft, drawn: DrawnIssues?, hint: (StepDraft) -> String?): CardIssue? =
	if (drawn != null) drawn.cards[step.key] else hint(step)?.let { CardIssue(null, it) }

internal sealed interface CardRow {
	val rowKey: String
	val depth: Int

	data class Card(
		val step: StepDraft,
		override val depth: Int,
		val path: String,
		val issue: CardIssue?,
		val last: AutomationLastStep?,
		val active: Boolean,
	) : CardRow {
		override val rowKey: String get() = step.key
	}

	data class SideLabel(val parent: String, val side: Side, override val depth: Int) : CardRow {
		override val rowKey: String get() = "$parent/${side.number}"
	}

	/** Full when insertion fails. */
	data class AddSlot(val slot: Slot, override val depth: Int, val full: Boolean) : CardRow {
		override val rowKey: String get() = "${slot.parent ?: "top"}/${slot.side?.number ?: ""}/add"
	}

	data class Branch(val parent: String, val label: BranchLabel, override val depth: Int) : CardRow {
		override val rowKey: String get() = "$parent/${label.key}"
	}

	data class AddBranch(val parent: String, val kind: BranchKind, override val depth: Int, val full: Boolean) : CardRow {
		override val rowKey: String get() = "$parent/${kind.name}/add"
	}
}

/** Row or owning card. */
internal sealed interface CardBlock {
	val row: CardRow

	/** Steps and add slots. */
	val indented: Boolean

	data class Owner(override val row: CardRow.Card, val inside: List<CardBlock>) : CardBlock {
		override val indented: Boolean get() = row.depth > 0
	}

	data class Loose(override val row: CardRow) : CardBlock {
		override val indented: Boolean get() = row is CardRow.AddSlot && row.depth > 0
	}
}

/** Deeper rows join above. */
internal fun cardBlocks(rows: List<CardRow>): List<CardBlock> {
	var at = 0
	fun level(depth: Int): List<CardBlock> = buildList {
		while (at < rows.size && rows[at].depth >= depth) {
			val row = rows[at++]
			add(if (row is CardRow.Card) CardBlock.Owner(row, level(row.depth + 1)) else CardBlock.Loose(row))
		}
	}
	return level(0)
}

internal enum class BranchKind { CASE, ELSE_IF }

internal sealed interface BranchLabel {
	val key: String

	/** Taken in last run. */
	data class Case(val view: CaseView, val number: Int, val taken: Boolean) : BranchLabel {
		override val key: String get() = view.case.key
	}

	data class Default(val falls: String, val taken: Boolean) : BranchLabel {
		override val key: String get() = "default"
	}

	data class Link(
		val step: StepDraft.If,
		val first: Boolean,
		val path: String,
		val issue: CardIssue?,
		val last: AutomationLastStep?,
	) : BranchLabel {
		override val key: String get() = step.key
	}

	data object Else : BranchLabel {
		override val key: String get() = "else"
	}
}

/** Paths under function calls. */
internal fun runPathOf(path: String, pointing: Boolean): String = if (pointing) "0.$path" else path

internal fun drawnAsChain(step: StepDraft): Boolean = step is StepDraft.If && chainOf(step).size > 1

/** Cards in written order. */
internal fun cardsDraw(
	steps: List<StepDraft>,
	issueOf: (StepDraft) -> CardIssue?,
	lastRun: AutomationLastRun?,
	pointing: Boolean,
	choicesOf: (String) -> List<AssistantFieldOption>? = { null },
): List<CardRow> {
	val drawer = CardsDrawer(steps, issueOf, lastRun, pointing, choicesOf)
	val top = Slot(null, null, steps.size)
	return drawer.rows(steps, null, 0) + CardRow.AddSlot(top, 0, drawer.full(top))
}

private class CardsDrawer(
	val steps: List<StepDraft>,
	val issueOf: (StepDraft) -> CardIssue?,
	lastRun: AutomationLastRun?,
	val pointing: Boolean,
	val choicesOf: (String) -> List<AssistantFieldOption>?,
) {
	private val last = lastRun?.steps.orEmpty().associateBy { it.path }
	private val active = lastRun?.active

	fun full(slot: Slot) = insertedStep(steps, slot, StepDraft.Exit("probe")) == null

	private fun lastAt(path: String) = last[runPathOf(path, pointing)]

	fun rows(list: List<StepDraft>, base: String?, depth: Int): List<CardRow> =
		list.withIndex().flatMap { (index, step) ->
			val path = if (base == null) "$index" else "$base.$index"
			// Head link owns status.
			val own = !drawnAsChain(step)
			val card = CardRow.Card(step, depth, path, issueOf(step).takeIf { own }, lastAt(path).takeIf { own }, runPathOf(path, pointing) == active)
			listOf(card) + sideRows(step, path, depth + 1)
		}

	private fun side(parent: String, side: Side, list: List<StepDraft>, path: String, depth: Int): List<CardRow> {
		val slot = Slot(parent, side, list.size)
		return rows(list, "$path.${side.number}", depth) + CardRow.AddSlot(slot, depth, full(slot))
	}

	private fun sideRows(step: StepDraft, path: String, depth: Int): List<CardRow> = when (step) {
		is StepDraft.If -> ifRows(step, path, depth)
		is StepDraft.Switch -> switchRows(step, path, depth)
		is StepDraft.Try ->
			side(step.key, Side.Body, step.body, path, depth) + CardRow.SideLabel(step.key, Side.Catch, depth) +
				side(step.key, Side.Catch, step.catch, path, depth)
		is StepDraft.Do, is StepDraft.Wait, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Call, is StepDraft.Kept -> emptyList()
	}

	private fun ifRows(step: StepDraft.If, path: String, depth: Int): List<CardRow> {
		val links = chainOf(step)
		val addLink = CardRow.AddBranch(step.key, BranchKind.ELSE_IF, depth, withElseIf(steps, step.key) == null)
		if (links.size == 1) {
			return side(step.key, Side.Then, step.then, path, depth) + addLink + CardRow.SideLabel(step.key, Side.Else, depth) +
				side(step.key, Side.Else, step.otherwise, path, depth)
		}
		val paths = links.indices.runningFold(path) { at, _ -> "$at.${Side.Else.number}.0" }
		val bodies = links.flatMapIndexed { index, link ->
			val at = paths[index]
			val label = BranchLabel.Link(link, index == 0, at, issueOf(link), lastAt(at))
			listOf(CardRow.Branch(step.key, label, depth)) + side(link.key, Side.Then, link.then, at, depth)
		}
		val end = links.last()
		return bodies + addLink + CardRow.Branch(step.key, BranchLabel.Else, depth) +
			side(end.key, Side.Else, end.otherwise, paths[links.lastIndex], depth)
	}

	private fun switchRows(step: StepDraft.Switch, path: String, depth: Int): List<CardRow> {
		val choices = choicesOf(step.subject)
		val taken = lastAt(path)?.case?.toInt()
		val cases = caseViews(step, choices).flatMapIndexed { number, view ->
			listOf(CardRow.Branch(step.key, BranchLabel.Case(view, number, taken == number), depth)) +
				side(step.key, Side.Case(number), view.case.steps, path, depth)
		}
		val fallback = BranchLabel.Default(defaultLine(step, choices), taken == step.cases.size)
		return cases + CardRow.AddBranch(step.key, BranchKind.CASE, depth, step.cases.size >= SWITCH_CASES) +
			CardRow.Branch(step.key, fallback, depth) + side(step.key, Side.Default(step.cases.size), step.default, path, depth)
	}
}

internal fun addedBranch(draft: AutomationDraft, row: CardRow.AddBranch): AutomationDraft = when (row.kind) {
	BranchKind.CASE -> draft.withSwitch(row.parent, ::withCase)
	BranchKind.ELSE_IF -> draft.plusElseIf(row.parent)
}

internal fun addBranchText(kind: BranchKind): String = when (kind) {
	BranchKind.CASE -> "+ Case"
	BranchKind.ELSE_IF -> "+ Else if"
}

internal data class StatementOffer(val kind: String, val label: String)

private val STATEMENTS = listOf(
	"if" to "If",
	"switch" to "Switch",
	"try" to "Try",
	"wait" to "Wait",
	"exit" to "Stop here",
	"note" to "Note",
	"call" to "Call",
)

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
	"switch" -> StepDraft.Switch(freshKey(), "", emptyList(), emptyList())
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
	is StepDraft.Switch -> "switch"
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

internal fun lastStepLine(card: CardRow.Card, running: Boolean): String? =
	if (card.active && running) "Running now" else lastLineOf(card.step, card.last)

internal fun lastLineOf(drawn: StepDraft, step: AutomationLastStep?): String? {
	if (step == null) return null
	val reason = step.reason?.let { ": $it" }.orEmpty()
	return when (Protocol.Wire.RunOutcome.entries.find { it.wire == step.outcome }) {
		null -> if (step.outcome == null) "Started" else "Last run: ${step.outcome}$reason"
		Protocol.Wire.RunOutcome.RAN -> when {
			step.case != null -> (drawn as? StepDraft.Switch)?.let { "Last run: took ${caseLabel(it, step.case.toInt())}" } ?: "Last run: done"
			step.side == "then" -> "Last run: it held"
			step.side == "else" -> "Last run: it did not hold"
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
	is StepDraft.If, is StepDraft.Try, is StepDraft.Switch, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Kept -> null
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
internal fun callLine(
	draft: AutomationDraft,
	offer: AutomationOffer,
	said: AutomationSaid?,
	function: String,
	/** Functions holding errors. */
	flagged: Set<String> = emptySet(),
): CallLine? {
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
		id in flagged || when (val source = functionSource(draft, offer, id)) {
			is FunctionSource.Cards -> source.callee?.let { calleeIssue(it, offer) } != null
			is FunctionSource.Listed -> source.row.invalid != null
			null -> false
		}
	}
	return CallLine.Attention.takeIf { saidBelow || issueBelow }
}

/** Trigger inputs appear given. */
internal fun callRows(draft: AutomationDraft, offer: AutomationOffer, fields: SourceFields, function: String): List<ValueRow>? {
	val params = calleeParams(draft, offer, function) ?: return null
	return valueRows(params, givenOf(draft, fields), emptyMap(), measureOf(draft))
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
