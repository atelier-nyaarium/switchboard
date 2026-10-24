package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.RuleSaved
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.Protocol

/** Mirrors `schemasAssistantRules`. */
internal val RULE_TESTS = listOf("is", "is_not", "contains")
internal val CHOICE_TESTS = listOf("is", "is_not")
internal val RULE_ACTIONS = listOf("wake", "inbox")
internal val MAX_RULES = Protocol.Wire.ASSISTANT_RULES_MAX
internal val MAX_CONDITIONS = Protocol.Wire.ASSISTANT_RULE_CONDITIONS_MAX
private val MAX_VALUE_LEN = Protocol.Wire.ASSISTANT_RULE_VALUE_MAX

internal fun testLabel(test: String): String = if (test == "is_not") "is not" else test

internal fun actionLabel(action: String): String = action.replaceFirstChar { it.uppercase() }

internal fun fieldLabel(field: String): String = field.replaceFirstChar { it.uppercase() }

internal val AssistantFieldSpec.field: String
	get() = when (this) {
		is AssistantFieldSpec.Enumeration -> field
		is AssistantFieldSpec.Text -> field
	}

internal val AssistantFieldSpec.label: String
	get() = when (this) {
		is AssistantFieldSpec.Enumeration -> label
		is AssistantFieldSpec.Text -> label
	}

/** Choice fields omit `contains`. */
internal fun testsOf(spec: AssistantFieldSpec?): List<String> =
	if (spec is AssistantFieldSpec.Enumeration) CHOICE_TESTS else RULE_TESTS

internal data class WatcherRules(
	val specs: List<AssistantFieldSpec>,
	val held: AssistantWatcherRules,
	/** Gateway reason keyed by rule ID. */
	val invalid: Map<String, String> = emptyMap(),
) {
	val fields: List<String> get() = specs.map { it.field }

	fun specOf(field: String): AssistantFieldSpec? = specs.find { it.field == field }

	fun fieldLabelOf(field: String): String = specOf(field)?.label ?: fieldLabel(field)

	/** Unlisted values stay raw. */
	fun valueLabelOf(field: String, value: String): String =
		(specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.find { it.value == value }?.label ?: value

	/** Stale held choice first; text has no menu. */
	fun choicesFor(field: String, held: String): List<String>? {
		val offered = (specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.map { it.value } ?: return null
		return if (held.isBlank() || held in offered) offered else listOf(held) + offered
	}

	/** Text takes any value. */
	fun offers(field: String, value: String): Boolean =
		(specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.any { it.value == value } ?: true

	/** "Reason is Review requested". */
	fun summary(rule: AssistantRule): String =
		rule.conditions.joinToString(" and ") {
			"${fieldLabelOf(it.field)} ${testLabel(it.test)} ${valueLabelOf(it.field, it.value)}"
		}

	/** Mirrors rule validation; blank drafts defer. */
	fun issueOf(condition: AssistantRuleCondition): String? {
		val spec = specOf(condition.field) ?: return "${fieldLabel(condition.field)} is not a field here"
		val value = condition.value.trim()
		if (value.isEmpty()) return null
		if (value.length > MAX_VALUE_LEN) return "At most $MAX_VALUE_LEN characters"
		if (condition.test !in testsOf(spec)) return "${spec.label} takes no \"${testLabel(condition.test)}\""
		if (spec is AssistantFieldSpec.Enumeration && spec.options.none { it.value == value }) {
			return "\"$value\" is no longer offered; pick again"
		}
		return null
	}
}

/** Legacy fields become text; absent fields mean null. */
internal fun rulesOf(watcher: AssistantWatcher): WatcherRules? {
	val specs = watcher.fieldSpecs?.takeIf { it.isNotEmpty() }
		?: watcher.fields?.map { AssistantFieldSpec.Text(field = it, label = fieldLabel(it)) }
	val held = watcher.rules ?: return null
	if (specs.isNullOrEmpty()) return null
	return WatcherRules(specs, held, watcher.invalid.orEmpty().associate { it.id to it.reason })
}

/** Which row the editor opened. */
internal sealed interface RuleSlot {
	data class Held(val id: String) : RuleSlot
	data object New : RuleSlot
	data object Otherwise : RuleSlot
}

/** The id above, or null. */
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
	fun withCondition(rules: WatcherRules): RuleDraft =
		if (conditions.size >= MAX_CONDITIONS) this else copy(conditions = conditions + blankCondition(rules))

	/** Same field keeps all; text-to-text keeps the value; others clear it. Unsupported tests reset. */
	fun withField(at: Int, field: String, rules: WatcherRules): RuleDraft = changed(at) { held ->
		if (field == held.field) return@changed held
		val was = rules.specOf(held.field)
		val now = rules.specOf(field)
		val keepsValue = was is AssistantFieldSpec.Text && now is AssistantFieldSpec.Text
		val test = held.test.takeIf { it in testsOf(now) } ?: testsOf(now).first()
		held.copy(field = field, test = test, value = if (keepsValue) held.value else "")
	}

	fun withoutCondition(at: Int): RuleDraft =
		if (conditions.size <= 1) this else copy(conditions = conditions.filterIndexed { index, _ -> index != at })

	fun changed(at: Int, change: (AssistantRuleCondition) -> AssistantRuleCondition): RuleDraft =
		copy(conditions = conditions.mapIndexed { index, held -> if (index == at) change(held) else held })

	/** Null until valid. */
	fun toRule(): AssistantRule? {
		val trimmed = conditions.map { it.copy(value = it.value.trim()) }
		if (trimmed.isEmpty() || trimmed.size > MAX_CONDITIONS) return null
		if (trimmed.any { it.value.isEmpty() || it.value.length > MAX_VALUE_LEN }) return null
		return AssistantRule(id = id, conditions = trimmed, action = action, revision = revision)
	}

	fun toOtherwise(): AssistantRuleOtherwise = AssistantRuleOtherwise(action = action, revision = revision)

	/** Rebased onto the held revision, so going over it is an owner tap. Null when there is nothing to go over. */
	fun over(held: AssistantWatcherRules, slot: RuleSlot): RuleDraft? {
		val now = if (slot == RuleSlot.Otherwise) held.otherwise.revision else held.rules.find { it.id == id }?.revision
		return now?.takeIf { it != revision }?.let { copy(revision = it) }
	}

	companion object {
		/** Null for a rule no longer held. */
		fun of(slot: RuleSlot, rules: WatcherRules): RuleDraft? = when (slot) {
			is RuleSlot.Held -> rules.held.rules.find { it.id == slot.id }?.let { draftOf(it) }
			RuleSlot.New -> RuleDraft(
				id = "rule-${java.util.UUID.randomUUID()}",
				conditions = listOf(blankCondition(rules)),
				action = "inbox",
				revision = 0L,
			)
			RuleSlot.Otherwise -> rules.held.otherwise.let { RuleDraft("otherwise", emptyList(), it.action, it.revision) }
		}

		fun draftOf(rule: AssistantRule): RuleDraft = RuleDraft(rule.id, rule.conditions, rule.action, rule.revision)
	}
}

private fun blankCondition(rules: WatcherRules): AssistantRuleCondition {
	val field = rules.fields.first()
	return AssistantRuleCondition(field = field, test = testsOf(rules.specOf(field)).first(), value = "")
}

private const val UNREACHABLE = "That Gateway could not be reached"

/** A list op's line; null when it landed. */
internal fun listText(saved: RuleSaved): String? = when (saved) {
	is RuleSaved.Stored -> null
	is RuleSaved.Refused -> saved.reason
	RuleSaved.Unreachable -> UNREACHABLE
}

internal sealed interface SaveOutcome {
	data object Done : SaveOutcome

	/** Changed elsewhere; the editor takes `draft`, and a second tap goes over the held revision. */
	data class Offer(val draft: RuleDraft, val line: String) : SaveOutcome

	data class Said(val reason: String) : SaveOutcome
}

/** The draft, or a delete of its rule. */
internal enum class RuleEdit { SAVE, DELETE }

/**
 * A refused save keeps the owner's draft over the held revision. A refused delete shows the held
 * rule instead, so a second Delete deletes what is there and a Save cannot carry an old copy over it.
 */
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

/** Shown opening has landed. */
internal fun editorLanded(shown: Long?, landed: Long?): Boolean = shown != null && shown == landed

/** The editor's rule left the held list. */
internal fun goneFrom(rules: WatcherRules, slot: RuleSlot): Boolean =
	slot is RuleSlot.Held && rules.held.rules.none { it.id == slot.id }

internal data class RuleEditing(val edit: Boolean, val save: Boolean, val delete: Boolean)

/** The rule Save sends and the preview asks about; null until it fits. */
internal fun fittingRule(draft: RuleDraft, rules: WatcherRules): AssistantRule? =
	draft.toRule()?.takeIf { draft.conditions.all { rules.issueOf(it) == null } }

/** Invalid rules allow edits and deletion; unsupported conditions block saving until fixed. */
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
