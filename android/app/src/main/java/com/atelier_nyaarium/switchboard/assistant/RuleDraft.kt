package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult

/** Mirrors `schemasAssistantRules`. */
internal val RULE_TESTS = listOf("is", "is_not", "contains")
internal val RULE_ACTIONS = listOf("wake", "inbox", "drop")
internal const val MAX_RULES = 50
internal const val MAX_CONDITIONS = 8
private const val MAX_VALUE_LEN = 200

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
	data class At(val index: Int) : RuleSlot
	data object New : RuleSlot
	data object Otherwise : RuleSlot
}

/** Null follows the default. */
internal fun pingAfter(on: Boolean, pingDefault: Boolean): Boolean? = on.takeIf { it != pingDefault }

/** A drop never pings. */
internal fun showsPing(action: String): Boolean = action != "drop"

internal fun rowPings(action: String, ping: Boolean?, pingDefault: Boolean): Boolean =
	showsPing(action) && (ping ?: pingDefault)

/** A refused save, read against the held rules. */
internal sealed interface AfterRefusal {
	/** The edit already stands, as after a lost answer. */
	data object Landed : AfterRefusal

	/** The edited row still stands; save again over this. */
	data class Over(val rules: WatcherRules) : AfterRefusal

	data object Stuck : AfterRefusal
}

internal fun afterRefusal(opened: WatcherRules, current: WatcherRules, slot: RuleSlot, draft: RuleDraft): AfterRefusal {
	if (current.held.revision == opened.held.revision) return AfterRefusal.Stuck
	val was = opened.held
	val now = current.held
	val (landed, stands) = when (slot) {
		is RuleSlot.At -> (now.rules.getOrNull(slot.index) == draft.toRule()) to
			(now.rules.getOrNull(slot.index) == was.rules.getOrNull(slot.index))
		RuleSlot.Otherwise -> (now.otherwise == draft.toOtherwise()) to (now.otherwise == was.otherwise)
		RuleSlot.New -> draft.toRule().let { rule -> now.rules.count { it == rule } > was.rules.count { it == rule } } to true
	}
	return when {
		landed -> AfterRefusal.Landed
		stands -> AfterRefusal.Over(current)
		else -> AfterRefusal.Stuck
	}
}

internal data class RuleDraft(
	val conditions: List<AssistantRuleCondition>,
	val action: String,
	val ping: Boolean?,
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
		return AssistantRule(conditions = trimmed, action = action, ping = ping.takeIf { showsPing(action) })
	}

	fun toOtherwise(): AssistantRuleOtherwise = AssistantRuleOtherwise(action = action, ping = ping.takeIf { showsPing(action) })

	companion object {
		fun of(slot: RuleSlot, rules: WatcherRules): RuleDraft = when (slot) {
			is RuleSlot.At -> rules.held.rules[slot.index].let { RuleDraft(it.conditions, it.action, it.ping) }
			RuleSlot.New -> RuleDraft(
				listOf(AssistantRuleCondition(field = rules.fields.first(), test = "is", value = "")),
				action = "inbox",
				ping = null,
			)
			RuleSlot.Otherwise -> RuleDraft(emptyList(), rules.held.otherwise.action, rules.held.otherwise.ping)
		}
	}
}

/** One whole-list save. */
internal data class RulesPut(val rules: List<AssistantRule>, val otherwise: AssistantRuleOtherwise, val base: Long)

internal fun saved(held: AssistantWatcherRules, slot: RuleSlot, draft: RuleDraft): RulesPut? {
	if (slot == RuleSlot.Otherwise) return RulesPut(held.rules, draft.toOtherwise(), held.revision)
	val rule = draft.toRule() ?: return null
	val rules = when (slot) {
		is RuleSlot.At -> held.rules.mapIndexed { index, it -> if (index == slot.index) rule else it }
		else -> if (held.rules.size >= MAX_RULES) return null else held.rules + rule
	}
	return RulesPut(rules, held.otherwise, held.revision)
}

internal fun deleted(held: AssistantWatcherRules, index: Int): RulesPut =
	RulesPut(held.rules.filterIndexed { at, _ -> at != index }, held.otherwise, held.revision)

/** Checked one place sooner. */
internal fun raised(held: AssistantWatcherRules, index: Int): RulesPut? {
	if (index <= 0 || index >= held.rules.size) return null
	val rules = held.rules.toMutableList().also { it.add(index - 1, it.removeAt(index)) }
	return RulesPut(rules, held.otherwise, held.revision)
}

internal fun previewText(preview: ConsoleAssistantPreviewResult): String {
	if (preview.of == 0L) return "No recent events."
	val head = "Would have matched ${preview.matched} of the last ${preview.of}"
	val listed = if (preview.titles.isEmpty()) "$head." else "$head: ${preview.titles.joinToString("; ")}."
	return if (preview.earlier > 0L) "$listed ${preview.earlier} more match an earlier rule first." else listed
}
