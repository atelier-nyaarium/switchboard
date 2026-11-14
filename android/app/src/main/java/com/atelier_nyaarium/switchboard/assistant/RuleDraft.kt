package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.RuleSaved
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal val RULE_ACTIONS = listOf("wake", "inbox")
internal val MAX_RULES = Protocol.Wire.ASSISTANT_RULES_MAX
internal val MAX_CONDITIONS = Protocol.Wire.ASSISTANT_RULE_CONDITIONS_MAX
private val MAX_VALUE_LEN = Protocol.Wire.ASSISTANT_RULE_VALUE_MAX

private val ASCII_EDGES = setOf(0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D)

/** ASCII whitespace edges only. */
internal fun trimRuleValue(value: String): String = value.trim { it.code in ASCII_EDGES }

internal fun testLabel(test: String): String = FieldTypes.TEST_LABELS[test] ?: test

internal fun actionLabel(action: String): String = action.replaceFirstChar { it.uppercase() }

internal fun fieldLabel(field: String): String = field.replaceFirstChar { it.uppercase() }

internal val AssistantFieldSpec.field: String
	get() = when (this) {
		is AssistantFieldSpec.Enumeration -> field
		is AssistantFieldSpec.Text -> field
		is AssistantFieldSpec.Number -> field
		is AssistantFieldSpec.Bytes -> field
		is AssistantFieldSpec.Unknown -> (raw["field"] as? JsonPrimitive)?.contentOrNull ?: kind
	}

internal val AssistantFieldSpec.label: String
	get() = when (this) {
		is AssistantFieldSpec.Enumeration -> label
		is AssistantFieldSpec.Text -> label
		is AssistantFieldSpec.Number -> label
		is AssistantFieldSpec.Bytes -> label
		is AssistantFieldSpec.Unknown -> (raw["label"] as? JsonPrimitive)?.contentOrNull ?: fieldLabel(field)
	}

/** Unknown kinds: no tests. */
internal fun testsOf(spec: AssistantFieldSpec?): List<String> =
	when (spec) {
		is AssistantFieldSpec.Enumeration -> FieldTypes.ROWS.getValue("enumeration").tests
		is AssistantFieldSpec.Text, null -> FieldTypes.ROWS.getValue("text").tests
		is AssistantFieldSpec.Number -> FieldTypes.ROWS.getValue("number").tests
		is AssistantFieldSpec.Bytes -> FieldTypes.ROWS.getValue("bytes").tests
		is AssistantFieldSpec.Unknown -> emptyList()
	}

internal data class WatcherRules(
	val specs: List<AssistantFieldSpec>,
	val held: AssistantWatcherRules,
	/** Gateway reasons by ID. */
	val invalid: Map<String, String> = emptyMap(),
) {
	val fields: List<String> get() = specs.map { it.field }

	val ruleFields: List<String> get() = specs.filter { testsOf(it).isNotEmpty() }.map { it.field }

	fun specOf(field: String): AssistantFieldSpec? = specs.find { it.field == field }

	fun fieldLabelOf(field: String): String = specOf(field)?.label ?: fieldLabel(field)

	/** Unlisted values stay raw. */
	fun valueLabelOf(field: String, value: String): String =
		(specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.find { it.value == value }?.label ?: value

	/** Keep stale enum choices. */
	fun choicesFor(field: String, held: String): List<String>? {
		val offered = (specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.map { it.value } ?: return null
		return if (trimRuleValue(held).isEmpty() || held in offered) offered else listOf(held) + offered
	}

	/** Non-enums accept any value. */
	fun offers(field: String, value: String): Boolean =
		(specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.any { it.value == value } ?: true

	fun summary(rule: AssistantRule): String =
		rule.conditions.joinToString(" and ") {
			"${fieldLabelOf(it.field)} ${testLabel(it.test)} ${valueLabelOf(it.field, it.value)}"
		}

	/** Blank drafts defer validation. */
	fun issueOf(condition: AssistantRuleCondition): String? {
		val spec = specOf(condition.field) ?: return "${fieldLabel(condition.field)} is not a field here"
		val value = trimRuleValue(condition.value)
		if (value.isEmpty()) return null
		if (value.length > MAX_VALUE_LEN) return "At most $MAX_VALUE_LEN characters"
		if (condition.test !in testsOf(spec)) return "${spec.label} takes no \"${testLabel(condition.test)}\""
		if (spec is AssistantFieldSpec.Enumeration && spec.options.none { it.value == value }) {
			return "\"$value\" is no longer offered; pick again"
		}
		return null
	}
}

/** Legacy fields become text. */
internal fun rulesOf(watcher: AssistantWatcher): WatcherRules? {
	val specs = watcher.fieldSpecs?.takeIf { it.isNotEmpty() }
		?: watcher.fields?.map { AssistantFieldSpec.Text(field = it, label = fieldLabel(it)) }
	val held = watcher.rules ?: return null
	if (specs.isNullOrEmpty()) return null
	return WatcherRules(specs, held, watcher.invalid.orEmpty().associate { it.id to it.reason })
}

internal sealed interface RuleSlot {
	data class Held(val id: String) : RuleSlot
	data object New : RuleSlot
	data object Otherwise : RuleSlot
}

/** Previous rule ID. */
internal fun raisedBefore(held: AssistantWatcherRules, ruleId: String): String? {
	val at = held.rules.indexOfFirst { it.id == ruleId }
	return if (at > 0) held.rules[at - 1].id else null
}

internal data class RuleDraft(
	val id: String,
	val conditions: List<AssistantRuleCondition>,
	val action: String,
	/** 0 adds the rule. */
	val revision: Long,
) {
	fun withCondition(rules: WatcherRules): RuleDraft {
		val blank = blankCondition(rules) ?: return this
		return if (conditions.size >= MAX_CONDITIONS) this else copy(conditions = conditions + blank)
	}

	/** Text-to-text changes preserve values. */
	fun withField(at: Int, field: String, rules: WatcherRules): RuleDraft = changed(at) { held ->
		if (field == held.field) return@changed held
		val was = rules.specOf(held.field)
		val now = rules.specOf(field)
		val keepsValue = was is AssistantFieldSpec.Text && now is AssistantFieldSpec.Text
		val test = held.test.takeIf { it in testsOf(now) } ?: testsOf(now).firstOrNull() ?: held.test
		held.copy(field = field, test = test, value = if (keepsValue) held.value else "")
	}

	fun withoutCondition(at: Int): RuleDraft =
		if (conditions.size <= 1) this else copy(conditions = conditions.filterIndexed { index, _ -> index != at })

	fun changed(at: Int, change: (AssistantRuleCondition) -> AssistantRuleCondition): RuleDraft =
		copy(conditions = conditions.mapIndexed { index, held -> if (index == at) change(held) else held })

	/** Null until valid. */
	fun toRule(): AssistantRule? {
		val trimmed = conditions.map { it.copy(value = trimRuleValue(it.value)) }
		if (trimmed.isEmpty() || trimmed.size > MAX_CONDITIONS) return null
		if (trimmed.any { it.value.isEmpty() || it.value.length > MAX_VALUE_LEN }) return null
		return AssistantRule(id = id, conditions = trimmed, action = action, revision = revision)
	}

	fun toOtherwise(): AssistantRuleOtherwise = AssistantRuleOtherwise(action = action, revision = revision)

	/** Rebase requires owner retry. */
	fun over(held: AssistantWatcherRules, slot: RuleSlot): RuleDraft? {
		val now = if (slot == RuleSlot.Otherwise) held.otherwise.revision else held.rules.find { it.id == id }?.revision
		return now?.takeIf { it != revision }?.let { copy(revision = it) }
	}

	companion object {
		/** Missing rules return null. */
		fun of(slot: RuleSlot, rules: WatcherRules): RuleDraft? = when (slot) {
			is RuleSlot.Held -> rules.held.rules.find { it.id == slot.id }?.let { draftOf(it) }
			RuleSlot.New -> blankCondition(rules)?.let {
				RuleDraft(id = "rule-${java.util.UUID.randomUUID()}", conditions = listOf(it), action = "inbox", revision = 0L)
			}
			RuleSlot.Otherwise -> rules.held.otherwise.let { RuleDraft("otherwise", emptyList(), it.action, it.revision) }
		}

		fun draftOf(rule: AssistantRule): RuleDraft = RuleDraft(rule.id, rule.conditions, rule.action, rule.revision)
	}
}

private fun blankCondition(rules: WatcherRules): AssistantRuleCondition? {
	val spec = rules.specs.firstOrNull { testsOf(it).isNotEmpty() } ?: return null
	return AssistantRuleCondition(field = spec.field, test = testsOf(spec).first(), value = "")
}

private const val UNREACHABLE = "That Gateway could not be reached"

internal fun listText(saved: RuleSaved): String? = when (saved) {
	is RuleSaved.Stored -> null
	is RuleSaved.Refused -> saved.reason
	RuleSaved.Unreachable -> UNREACHABLE
}

internal sealed interface SaveOutcome {
	data object Done : SaveOutcome

	/** Rebased writes need confirmation. */
	data class Offer(val draft: RuleDraft, val line: String) : SaveOutcome

	data class Said(val reason: String) : SaveOutcome
}

internal enum class RuleEdit { SAVE, DELETE }

/** Save rebases; delete restores. */
internal fun outcomeOf(saved: RuleSaved, draft: RuleDraft, slot: RuleSlot, edit: RuleEdit = RuleEdit.SAVE): SaveOutcome =
	when (saved) {
		is RuleSaved.Stored -> SaveOutcome.Done
		RuleSaved.Unreachable -> SaveOutcome.Said(UNREACHABLE)
		is RuleSaved.Refused -> {
			val held = saved.held
			val offer = when {
				held == null -> null
				edit == RuleEdit.DELETE -> held.rules.find { it.id == draft.id }?.let {
					SaveOutcome.Offer(RuleDraft.draftOf(it), DELETE_OVER)
				}
				else -> draft.over(held, slot)?.let { SaveOutcome.Offer(it, SAVE_OVER) }
			}
			offer ?: SaveOutcome.Said(saved.reason)
		}
	}

private const val SAVE_OVER = "It changed elsewhere. Save again to go over it."
private const val DELETE_OVER = "It changed elsewhere; this is it now. Delete again to delete it."

internal fun editorLanded(shown: Long?, landed: Long?): Boolean = shown != null && shown == landed

internal fun goneFrom(rules: WatcherRules, slot: RuleSlot): Boolean =
	slot is RuleSlot.Held && rules.held.rules.none { it.id == slot.id }

internal data class RuleEditing(val edit: Boolean, val save: Boolean, val delete: Boolean)

/** Shared save/preview validation. */
internal fun fittingRule(draft: RuleDraft, rules: WatcherRules): AssistantRule? =
	draft.toRule()?.takeIf { draft.conditions.all { rules.issueOf(it) == null } }

/** Invalid rules stay editable. */
internal fun ruleEditing(slot: RuleSlot, draft: RuleDraft, busy: Boolean, gone: Boolean, rules: WatcherRules): RuleEditing {
	val edit = !busy && !gone
	val valid = slot == RuleSlot.Otherwise || fittingRule(draft, rules) != null
	return RuleEditing(edit = edit, save = edit && valid, delete = edit && slot is RuleSlot.Held)
}

internal fun previewText(preview: ConsoleAssistantPreviewResult): String {
	if (preview.of == 0L) return "No recent events."
	val head = "Would have matched ${preview.decided} of the last ${preview.of}"
	val listed = if (preview.titles.isEmpty()) "$head." else "$head: ${preview.titles.joinToString("; ")}."
	return if (preview.shadowed > 0L) "$listed ${preview.shadowed} more match an earlier rule first." else listed
}
