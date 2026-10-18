package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.RuleSaved
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.Protocol

/** Mirrors `schemasAssistantRules`. */
internal val RULE_TESTS = listOf("is", "is_not", "contains")
internal val RULE_ACTIONS = listOf("wake", "inbox", "drop")
internal val MAX_RULES = Protocol.Wire.ASSISTANT_RULES_MAX
internal val MAX_CONDITIONS = Protocol.Wire.ASSISTANT_RULE_CONDITIONS_MAX
private val MAX_VALUE_LEN = Protocol.Wire.ASSISTANT_RULE_VALUE_MAX

internal fun testLabel(test: String): String = if (test == "is_not") "is not" else test

internal fun actionLabel(action: String): String = action.replaceFirstChar { it.uppercase() }

internal fun fieldLabel(field: String): String = field.replaceFirstChar { it.uppercase() }

internal fun ruleSummary(rule: AssistantRule): String =
	rule.conditions.joinToString(" and ") { "${it.field} ${testLabel(it.test)} ${it.value}" }

internal data class WatcherRules(val fields: List<String>, val pingDefault: Boolean, val held: AssistantWatcherRules)

/** Null from an older Gateway. */
internal fun rulesOf(watcher: AssistantWatcher): WatcherRules? {
	val fields = watcher.fields?.takeIf { it.isNotEmpty() } ?: return null
	val held = watcher.rules ?: return null
	return WatcherRules(fields, watcher.pingDefault ?: false, held)
}

/** Which row the editor opened. */
internal sealed interface RuleSlot {
	data class Held(val id: String) : RuleSlot
	data object New : RuleSlot
	data object Otherwise : RuleSlot
}

/** Null follows the default. */
internal fun pingAfter(on: Boolean, pingDefault: Boolean): Boolean? = on.takeIf { it != pingDefault }

/** A drop never pings. */
internal fun showsPing(action: String): Boolean = action != "drop"

internal fun rowPings(action: String, ping: Boolean?, pingDefault: Boolean): Boolean =
	showsPing(action) && (ping ?: pingDefault)

/** The id above, or null. */
internal fun raisedBefore(held: AssistantWatcherRules, ruleId: String): String? {
	val at = held.rules.indexOfFirst { it.id == ruleId }
	return if (at > 0) held.rules[at - 1].id else null
}

internal data class RuleDraft(
	val id: String,
	val conditions: List<AssistantRuleCondition>,
	val action: String,
	val ping: Boolean?,
	/** 0 adds the rule. */
	val revision: Long,
) {
	fun pings(pingDefault: Boolean): Boolean = rowPings(action, ping, pingDefault)

	fun withCondition(fields: List<String>): RuleDraft =
		if (conditions.size >= MAX_CONDITIONS) this
		else copy(conditions = conditions + AssistantRuleCondition(field = fields.first(), test = "is", value = ""))

	fun withoutCondition(at: Int): RuleDraft =
		if (conditions.size <= 1) this else copy(conditions = conditions.filterIndexed { index, _ -> index != at })

	fun changed(at: Int, change: (AssistantRuleCondition) -> AssistantRuleCondition): RuleDraft =
		copy(conditions = conditions.mapIndexed { index, held -> if (index == at) change(held) else held })

	/** Null until valid. */
	fun toRule(): AssistantRule? {
		val trimmed = conditions.map { it.copy(value = it.value.trim()) }
		if (trimmed.isEmpty() || trimmed.size > MAX_CONDITIONS) return null
		if (trimmed.any { it.value.isEmpty() || it.value.length > MAX_VALUE_LEN }) return null
		return AssistantRule(
			id = id,
			conditions = trimmed,
			action = action,
			ping = ping.takeIf { showsPing(action) },
			revision = revision,
		)
	}

	fun toOtherwise(): AssistantRuleOtherwise =
		AssistantRuleOtherwise(action = action, ping = ping.takeIf { showsPing(action) }, revision = revision)

	/** Rebased onto the held revision, so going over it is an owner tap. Null when there is nothing to go over. */
	fun over(held: AssistantWatcherRules, slot: RuleSlot): RuleDraft? {
		val now = if (slot == RuleSlot.Otherwise) held.otherwise.revision else held.rules.find { it.id == id }?.revision
		return now?.takeIf { it != revision }?.let { copy(revision = it) }
	}

	companion object {
		/** Null for a rule no longer held. */
		fun of(slot: RuleSlot, rules: WatcherRules): RuleDraft? = when (slot) {
			is RuleSlot.Held -> rules.held.rules.find { it.id == slot.id }?.let {
				RuleDraft(it.id, it.conditions, it.action, it.ping, it.revision)
			}
			RuleSlot.New -> RuleDraft(
				id = "rule-${java.util.UUID.randomUUID()}",
				conditions = listOf(AssistantRuleCondition(field = rules.fields.first(), test = "is", value = "")),
				action = "inbox",
				ping = null,
				revision = 0L,
			)
			RuleSlot.Otherwise -> rules.held.otherwise.let { RuleDraft("otherwise", emptyList(), it.action, it.ping, it.revision) }
		}
	}
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
					SaveOutcome.Offer(RuleDraft(it.id, it.conditions, it.action, it.ping, it.revision), DELETE_OVER)
				}
				else -> draft.over(held, slot)?.let { SaveOutcome.Offer(it, SAVE_OVER) }
			}
			offer ?: SaveOutcome.Said(saved.reason)
		}
	}

private const val SAVE_OVER = "It changed elsewhere. Save again to go over it."
private const val DELETE_OVER = "It changed elsewhere; this is it now. Delete again to delete it."

/** The editor's rule left the held list. */
internal fun goneFrom(rules: WatcherRules, slot: RuleSlot): Boolean =
	slot is RuleSlot.Held && rules.held.rules.none { it.id == slot.id }

internal fun previewText(preview: ConsoleAssistantPreviewResult): String {
	if (preview.of == 0L) return "No recent events."
	val head = "Would have matched ${preview.decided} of the last ${preview.of}"
	val listed = if (preview.titles.isEmpty()) "$head." else "$head: ${preview.titles.joinToString("; ")}."
	return if (preview.shadowed > 0L) "$listed ${preview.shadowed} more match an earlier rule first." else listed
}
