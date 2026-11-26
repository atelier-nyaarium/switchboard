package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
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

private val STATEMENTS = listOf("if" to "If", "try" to "Try", "wait" to "Wait", "exit" to "Stop here", "note" to "Note")

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

/** A body holding a statement its Gateway does not run opens read-only. */
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
internal fun cardHint(step: StepDraft, offer: AutomationOffer, valueNames: Set<String>): String? = when (step) {
	is StepDraft.Do -> actionHint(step.action, offer, valueNames)
	is StepDraft.Wait -> step.minutes.takeIf { it.isNotBlank() }?.let(::waitIssue)
	is StepDraft.If, is StepDraft.Try, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Kept -> null
}

internal fun waitIssue(typed: String): String? {
	val minutes = parseDecimal(typed.trim()) ?: return "Minutes as a number"
	return "From 0 to ${Protocol.Wire.WAIT_MINUTES_MAX} minutes".takeIf { minutes < 0 || minutes > Protocol.Wire.WAIT_MINUTES_MAX }
}
