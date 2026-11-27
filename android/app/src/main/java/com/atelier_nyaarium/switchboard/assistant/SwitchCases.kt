package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleTokenKind
import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationIssueLevel

// Twin of `switch-cases.ts`.

internal val SWITCH_CASES = Protocol.Wire.SWITCH_CASES_MAX
internal val CASE_VALUES = Protocol.Wire.SWITCH_CASE_VALUES_MAX

internal fun caseKey(value: String): String = trimRuleValue(value).lowercase()

private const val EVENT = "event"

/** Exactly `event.<field>`. */
internal fun choiceFieldOf(subject: String): String? {
	val tokens = lexConsole(subject)
	if (tokens.size != 3) return null
	val (target, dot, name) = tokens
	val plain = target.kind == ConsoleTokenKind.IDENT && target.text == EVENT &&
		dot.kind == ConsoleTokenKind.PUNCT && dot.text == "." && name.kind == ConsoleTokenKind.IDENT
	return name.text.takeIf { plain }
}

internal enum class SwitchIssueWhy(val wire: String) {
	EMPTY("empty"),

	TWICE("twice"),

	VANISHED("vanished"),
}

internal data class SwitchIssue(
	val level: AutomationIssueLevel,
	val why: SwitchIssueWhy,
	val case: Int,
	/** Absent for `EMPTY`. */
	val chip: Int? = null,
	val value: String? = null,
)

/** Null choices mean text. */
internal fun switchIssues(cases: List<List<String>>, choices: List<String>?): List<SwitchIssue> {
	val offered = choices?.map(::caseKey)?.toSet()
	val seen = mutableSetOf<String>()
	val issues = mutableListOf<SwitchIssue>()
	cases.forEachIndexed { at, values ->
		if (values.isEmpty()) issues += SwitchIssue(AutomationIssueLevel.ERROR, SwitchIssueWhy.EMPTY, at)
		values.forEachIndexed { chip, value ->
			val key = caseKey(value)
			when {
				key in seen -> issues += SwitchIssue(AutomationIssueLevel.ERROR, SwitchIssueWhy.TWICE, at, chip, value)
				offered != null && key !in offered -> issues += SwitchIssue(AutomationIssueLevel.WARNING, SwitchIssueWhy.VANISHED, at, chip, value)
			}
			seen += key
		}
	}
	return issues
}

internal fun switchOptions(subject: String, fields: SourceFields): List<AssistantFieldOption>? =
	choiceFieldOf(subject)?.let { fields.specOf(it) as? AssistantFieldSpec.Enumeration }?.options

internal fun optionsLeft(step: StepDraft.Switch, options: List<AssistantFieldOption>): List<AssistantFieldOption> {
	val used = step.cases.flatMap { it.values }.map(::caseKey).toSet()
	return options.filter { caseKey(it.value) !in used }
}

/** Default takes unmatched values. */
internal fun defaultLine(step: StepDraft.Switch, options: List<AssistantFieldOption>?): String {
	val left = options?.let { optionsLeft(step, it).map { option -> option.label } } ?: return "Anything else"
	return if (left.isEmpty()) "Anything new" else "${left.joinToString(", ")}, and anything new"
}

internal data class CaseChip(val value: String, val label: String, val issue: CardIssue?)

/** + chip choices. */
internal sealed interface CaseAdd {
	data class Pick(val options: List<AssistantFieldOption>) : CaseAdd

	data object Type : CaseAdd

	data object Full : CaseAdd
}

internal data class CaseView(val case: CaseDraft, val chips: List<CaseChip>, val issue: CardIssue?, val add: CaseAdd)

private fun issueLine(issue: SwitchIssue): String = when (issue.why) {
	SwitchIssueWhy.EMPTY -> "A case holds no value"
	SwitchIssueWhy.TWICE -> "Given before"
	SwitchIssueWhy.VANISHED -> "No longer one of its values"
}

internal fun caseViews(step: StepDraft.Switch, options: List<AssistantFieldOption>?): List<CaseView> {
	val issues = switchIssues(step.cases.map { it.values }, options?.map { it.value })
	val labelOf = { value: String -> options?.firstOrNull { caseKey(it.value) == caseKey(value) }?.label ?: value }
	val left = options?.let { optionsLeft(step, it) }
	return step.cases.mapIndexed { at, held ->
		val chips = held.values.mapIndexed { chip, value ->
			val issue = issues.firstOrNull { it.case == at && it.chip == chip }
			CaseChip(value, labelOf(value), issue?.let { CardIssue(it.level, issueLine(it), labelOf(value)) })
		}
		val empty = issues.firstOrNull { it.case == at && it.chip == null }?.let { CardIssue(it.level, issueLine(it)) }
		val add = when {
			held.values.size >= CASE_VALUES -> CaseAdd.Full
			left == null -> CaseAdd.Type
			left.isEmpty() -> CaseAdd.Full
			else -> CaseAdd.Pick(left)
		}
		CaseView(held, chips, empty, add)
	}
}

internal fun caseLabel(step: StepDraft.Switch, number: Int): String =
	step.cases.getOrNull(number)?.values?.joinToString(", ")?.ifEmpty { "a case with no value" } ?: "default"

/** Null when invalid. */
internal fun caseValueOf(typed: String): String? =
	trimRuleValue(typed).takeIf { it.isNotEmpty() && it.length <= Protocol.Wire.ASSISTANT_RULE_VALUE_MAX }

private fun onCase(step: StepDraft.Switch, case: String, change: (CaseDraft) -> CaseDraft): StepDraft.Switch =
	step.copy(cases = step.cases.map { if (it.key == case) change(it) else it })

internal fun withCaseValue(step: StepDraft.Switch, case: String, value: String): StepDraft.Switch =
	onCase(step, case) { held -> if (held.values.size >= CASE_VALUES) held else held.copy(values = held.values + value) }

/** Values may repeat. */
internal fun withoutCaseValue(step: StepDraft.Switch, case: String, at: Int): StepDraft.Switch =
	onCase(step, case) { held -> held.copy(values = held.values.filterIndexed { index, _ -> index != at }) }

internal fun withCase(step: StepDraft.Switch): StepDraft.Switch? =
	step.takeIf { it.cases.size < SWITCH_CASES }?.copy(cases = step.cases + CaseDraft(freshKey(), emptyList(), emptyList()))

internal fun withoutCase(step: StepDraft.Switch, case: String): StepDraft.Switch = step.copy(cases = step.cases.filter { it.key != case })
