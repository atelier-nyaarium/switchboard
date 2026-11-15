package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.AutomationSaved
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal val MAX_CONDITIONS = Protocol.Wire.ASSISTANT_RULE_CONDITIONS_MAX
private val MAX_VALUE_LEN = Protocol.Wire.ASSISTANT_RULE_VALUE_MAX
private val ASCII_EDGES = setOf(0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D)

internal fun trimRuleValue(value: String): String = value.trim { it.code in ASCII_EDGES }

internal fun testLabel(test: String): String = FieldTypes.TEST_LABELS[test] ?: test

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

internal fun testsOf(spec: AssistantFieldSpec?): List<String> =
	when (spec) {
		is AssistantFieldSpec.Enumeration -> FieldTypes.ROWS.getValue("enumeration").tests
		is AssistantFieldSpec.Text, null -> FieldTypes.ROWS.getValue("text").tests
		is AssistantFieldSpec.Number -> FieldTypes.ROWS.getValue("number").tests
		is AssistantFieldSpec.Bytes -> FieldTypes.ROWS.getValue("bytes").tests
		is AssistantFieldSpec.Unknown -> emptyList()
	}

internal data class SourceFields(val specs: List<AssistantFieldSpec>) {
	val fields: List<String> get() = specs.map { it.field }
	val ruleFields: List<String> get() = specs.filter { testsOf(it).isNotEmpty() }.map { it.field }

	fun specOf(field: String): AssistantFieldSpec? = specs.find { it.field == field }

	fun fieldLabelOf(field: String): String = specOf(field)?.label ?: fieldLabel(field)

	fun valueLabelOf(field: String, value: String): String =
		(specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.find { it.value == value }?.label ?: value

	fun choicesFor(field: String, held: String): List<String>? {
		val offered = (specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.map { it.value } ?: return null
		return if (trimRuleValue(held).isEmpty() || held in offered) offered else listOf(held) + offered
	}

	fun offers(field: String, value: String): Boolean =
		(specOf(field) as? AssistantFieldSpec.Enumeration)?.options?.any { it.value == value } ?: true

	fun issueOf(condition: AutomationCondition): String? {
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

internal sealed interface AutomationSlot {
	data class Held(val id: String) : AutomationSlot
	data object New : AutomationSlot
}

internal data class AutomationDraft(
	val id: String,
	val source: String,
	val conditions: List<AutomationCondition>,
	val tell: String,
	val enabled: Boolean,
	val revision: Long,
	val original: Automation? = null,
) {
	fun withCondition(fields: SourceFields): AutomationDraft {
		if (conditions.size >= MAX_CONDITIONS) return this
		val spec = fields.specs.firstOrNull { testsOf(it).isNotEmpty() } ?: return this
		val test = testsOf(spec).first()
		return copy(conditions = conditions + AutomationCondition(spec.field, test, ""))
	}

	fun withField(at: Int, field: String, fields: SourceFields): AutomationDraft = changed(at) { held ->
		if (field == held.field) return@changed held
		val was = fields.specOf(held.field)
		val now = fields.specOf(field)
		val keepsValue = was is AssistantFieldSpec.Text && now is AssistantFieldSpec.Text
		val test = held.test.takeIf { it in testsOf(now) } ?: testsOf(now).firstOrNull() ?: held.test
		held.copy(field = field, test = test, value = if (keepsValue) held.value else "")
	}

	fun withoutCondition(at: Int): AutomationDraft =
		copy(conditions = conditions.filterIndexed { index, _ -> index != at })

	fun changed(at: Int, change: (AutomationCondition) -> AutomationCondition): AutomationDraft =
		copy(conditions = conditions.mapIndexed { index, held -> if (index == at) change(held) else held })

	fun withSource(source: String): AutomationDraft = copy(source = source, conditions = emptyList())

	fun toAutomation(): Automation? {
		if (source.isBlank() || conditions.size > MAX_CONDITIONS) return null
		val trimmed = conditions.map { it.copy(value = trimRuleValue(it.value)) }
		if (trimmed.any { it.value.isEmpty() || it.value.length > MAX_VALUE_LEN }) return null
		val actions = original?.actions.orEmpty()
		val told = actions.any { it is AutomationAction.TellAssistant }
		val keptActions = actions.map { action ->
			if (action is AutomationAction.TellAssistant) action.copy(`when` = tell) else action
		}
		return Automation(
			label = original?.label,
			enabled = enabled,
			trigger = AutomationTrigger.Event(source = source, conditions = trimmed),
			actions = when {
				original == null -> listOf(AutomationAction.TellAssistant(`when` = tell))
				told -> keptActions
				else -> keptActions + AutomationAction.TellAssistant(`when` = tell)
			},
		)
	}

	fun changedFrom(opened: AutomationDraft): Boolean =
		source != opened.source || conditions != opened.conditions || tell != opened.tell || enabled != opened.enabled
}

internal fun newAutomationDraft(sources: List<AssistantSource>): AutomationDraft? {
	val source = sources.firstOrNull { it.triggers } ?: return null
	return AutomationDraft(
		id = "auto-${java.util.UUID.randomUUID()}",
		source = source.id,
		conditions = emptyList(),
		tell = "now",
		enabled = true,
		revision = 0L,
	)
}

internal fun automationDraftOf(row: AutomationRow): AutomationDraft {
	val trigger = row.automation.trigger as? AutomationTrigger.Event
	val tell = row.automation.actions.filterIsInstance<AutomationAction.TellAssistant>().firstOrNull()?.`when` ?: "now"
	return AutomationDraft(
		id = row.id,
		source = trigger?.source.orEmpty(),
		conditions = trigger?.conditions.orEmpty(),
		tell = tell,
		enabled = row.automation.enabled,
		revision = row.revision,
		original = row.automation,
	)
}

/** Shared save and preview validation. */
internal fun fittingAutomation(draft: AutomationDraft, fields: SourceFields): Automation? =
	draft.toAutomation()?.takeIf { draft.conditions.all { condition -> fields.issueOf(condition) == null } }

/** What the editor opens with. */
internal fun openedDraft(slot: AutomationSlot, row: AutomationRow?, sources: List<AssistantSource>): AutomationDraft? = when (slot) {
	is AutomationSlot.Held -> row?.takeIf(::editable)?.let(::automationDraftOf)
	AutomationSlot.New -> newAutomationDraft(sources)
}

/** Held source stays first. */
internal fun sourceChoices(sources: List<AssistantSource>, held: String): List<String> {
	val offered = sources.filter { it.triggers }.map { it.id }
	return if (held.isBlank() || held in offered) offered else listOf(held) + offered
}

internal data class AutomationEditing(val edit: Boolean, val save: Boolean, val delete: Boolean)

/** An unfit draft stays editable. */
internal fun automationEditing(
	slot: AutomationSlot,
	draft: AutomationDraft,
	fields: SourceFields,
	offered: Boolean,
	busy: Boolean,
	gone: Boolean,
): AutomationEditing {
	val edit = !busy && !gone
	return AutomationEditing(
		edit = edit,
		save = edit && offered && fittingAutomation(draft, fields) != null,
		delete = edit && slot is AutomationSlot.Held,
	)
}

internal fun editorLanded(shown: Long?, landed: Long?): Boolean = shown != null && shown == landed

internal data class AutomationGroup(val gatewayId: String, val assistant: Boolean, val rows: List<AutomationRow>) {
	/** Only the home takes an event automation. */
	fun edits(row: AutomationRow): Boolean = assistant && editable(row)
}

/** Gateways that list any, the home first. */
internal fun automationGroups(registry: GatewayRegistry, home: String?): List<AutomationGroup> =
	registry.gateways
		.filter { !it.automations.isNullOrEmpty() }
		.map { AutomationGroup(it.id, it.id == home, it.automations.orEmpty()) }
		.sortedByDescending { it.assistant }

/** "5 automations". */
internal fun automationCountLine(count: Int): String = when (count) {
	0 -> "None"
	1 -> "1 automation"
	else -> "$count automations"
}

internal fun editable(row: AutomationRow): Boolean =
	row.device == null && row.automation.trigger is AutomationTrigger.Event &&
	row.automation.actions.none { it is AutomationAction.Unknown }

internal sealed interface AutomationOutcome {
	data object Done : AutomationOutcome
	data class Offer(val draft: AutomationDraft, val line: String) : AutomationOutcome
	data class Said(val reason: String) : AutomationOutcome
}

internal fun outcomeOf(saved: AutomationSaved, draft: AutomationDraft, deleting: Boolean = false): AutomationOutcome =
	when (saved) {
		is AutomationSaved.Stored -> AutomationOutcome.Done
		AutomationSaved.Unreachable -> AutomationOutcome.Said("That Gateway could not be reached")
		is AutomationSaved.Refused -> {
			val held = saved.heldRow?.takeIf { it.id == draft.id && it.revision != draft.revision && editable(it) }
			when {
				held == null -> AutomationOutcome.Said(saved.reason)
				deleting -> AutomationOutcome.Offer(
					automationDraftOf(held),
					"It changed elsewhere; this is it now. Delete again to delete it.",
				)
				else -> AutomationOutcome.Offer(
					draft.copy(revision = held.revision, original = held.automation, enabled = held.automation.enabled),
					"It changed elsewhere. Save again to go over it.",
				)
			}
		}
	}

internal fun doesText(automation: Automation): String = automation.actions.joinToString(" · ") { action ->
	when (action) {
		is AutomationAction.TellAssistant -> if (action.`when` == "quietly") "Tell the assistant quietly" else "Tell the assistant now"
		is AutomationAction.Unknown -> action.kind
	}
}

internal fun ranText(row: AutomationRow, ago: (Long) -> String): String =
	row.lastRanAt?.let { "Ran ${ago(it)}" } ?: "Never ran"

/** "4 use this source". */
internal fun usesText(count: Int): String = if (count == 1) "1 uses this source" else "$count use this source"

/** "reason, type, repository". */
internal fun producesText(specs: List<AssistantFieldSpec>): String =
	specs.joinToString(", ") { spec -> spec.label.replaceFirstChar { it.lowercase() } }

/** Null for no recent events. */
internal fun previewHead(preview: ConsoleAutomationPreviewResult): String? =
	if (preview.of == 0L) null else "Would have matched ${preview.matched} of the last ${preview.of}"

internal fun usesOf(sourceId: String, rows: List<AutomationRow>): Int = rows.count { row ->
	(row.automation.trigger as? AutomationTrigger.Event)?.source == sourceId
}
