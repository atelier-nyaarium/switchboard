package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.AssistantHome
import com.atelier_nyaarium.switchboard.AutomationSaved
import com.atelier_nyaarium.switchboard.EditStanding
import com.atelier_nyaarium.switchboard.waitingLine
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.GatewayList
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.ListEmpty
import com.atelier_nyaarium.switchboard.groupedView
import com.atelier_nyaarium.switchboard.listedGroups
import com.atelier_nyaarium.switchboard.openingDraft
import com.atelier_nyaarium.switchboard.FUNCTION_MOVED_LINE
import com.atelier_nyaarium.switchboard.automationSavedOf
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationCheckResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.Protocol
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

	/** Device to cross. */
	data class New(val watch: String? = null) : AutomationSlot
}

internal data class AutomationDraft(
	val id: String,
	val trigger: TriggerDraft,
	/** The cards, each by its key. */
	val steps: List<StepDraft>,
	val enabled: Boolean,
	val revision: Long,
	/** Survives a restart. */
	val context: EditContext,
	val original: Automation? = null,
	/** Triggers swapped away, newest first. */
	val stash: List<TriggerDraft> = emptyList(),
	/** The text open on its own page. */
	val text: TextRef? = null,
	/** Unit its numbers are typed in. */
	val display: String? = null,
	/** Its own, or a function's head; `steps` are the cards. */
	val runs: RunsHead = RunsHead.Own,
	/** Function ID survives edits. */
	val newFunctionId: String? = null,
	/** The function picker is open. */
	val picking: Boolean = false,
) {
	fun runsDraft(): RunsDraft = runsOf(runs, steps)

	fun withRuns(next: RunsDraft): AutomationDraft = headOf(next).let { (head, cards) -> copy(runs = head, steps = cards) }

	private val event: TriggerDraft.Event? get() = trigger as? TriggerDraft.Event

	/** Blank unless an event triggers it. */
	val source: String get() = event?.source.orEmpty()

	val conditions: List<AutomationCondition> get() = event?.conditions.orEmpty()

	private fun onEvent(change: (TriggerDraft.Event) -> TriggerDraft.Event): AutomationDraft =
		event?.let { copy(trigger = change(it)) } ?: this

	fun withCondition(fields: SourceFields): AutomationDraft {
		if (conditions.size >= MAX_CONDITIONS) return this
		val spec = fields.specs.firstOrNull { testsOf(it).isNotEmpty() } ?: return this
		val test = testsOf(spec).first()
		return onEvent { it.copy(conditions = it.conditions + AutomationCondition(spec.field, test, "")) }
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
		onEvent { it.copy(conditions = it.conditions.filterIndexed { index, _ -> index != at }) }

	fun changed(at: Int, change: (AutomationCondition) -> AutomationCondition): AutomationDraft =
		onEvent { it.copy(conditions = it.conditions.mapIndexed { index, held -> if (index == at) change(held) else held }) }

	fun withSource(source: String): AutomationDraft = onEvent { TriggerDraft.Event(source, emptyList()) }

	/** A kind swapped away comes back as it was left. */
	fun swapped(kinds: Set<String>, fresh: () -> TriggerDraft?): AutomationDraft {
		if (trigger.kind in kinds) return this
		val next = stash.firstOrNull { it.kind in kinds } ?: fresh() ?: return this
		return copy(trigger = next, stash = listOf(trigger) + stash.filter { it.kind != trigger.kind && it.kind != next.kind })
	}

	fun onCrossing(change: (TriggerDraft.Crossing) -> TriggerDraft.Crossing): AutomationDraft =
		(trigger as? TriggerDraft.Crossing)?.let { copy(trigger = change(it)) } ?: this

	fun onTime(change: (TriggerDraft.Time) -> TriggerDraft.Time): AutomationDraft =
		(trigger as? TriggerDraft.Time)?.let { copy(trigger = change(it)) } ?: this

	fun onInterval(change: (TriggerDraft.Interval) -> TriggerDraft.Interval): AutomationDraft =
		(trigger as? TriggerDraft.Interval)?.let { copy(trigger = change(it)) } ?: this

	/** The card at `key` changed. */
	fun withStep(key: String, change: (StepDraft) -> StepDraft): AutomationDraft = copy(steps = replacedStep(steps, key, change))

	/** The action of the card at `key` changed. */
	fun withAction(key: String, change: (ActionDraft) -> ActionDraft): AutomationDraft =
		withStep(key) { step -> if (step is StepDraft.Do) step.copy(action = change(step.action)) else step }

	/** Unchanged where a cap refuses it. */
	fun plusStep(slot: Slot, step: StepDraft): AutomationDraft = insertedStep(steps, slot, step)?.let { copy(steps = it) } ?: this

	fun plusAction(action: ActionDraft): AutomationDraft = plusStep(Slot(null, null, steps.size), StepDraft.Do(freshKey(), action))

	fun minusStep(key: String): AutomationDraft = copy(steps = removedStep(steps, key))

	/** Null while the trigger cannot be saved. */
	fun builtTrigger(offer: AutomationOffer): AutomationTrigger? {
		val built = triggerOf(trigger, offer, display) ?: return null
		val unfit = built is AutomationTrigger.Event &&
			built.conditions.any { it.value.isEmpty() || it.value.length > MAX_VALUE_LEN }
		return built.takeUnless { unfit }
	}

	/** Null while the trigger or an action cannot be saved. */
	fun toAutomation(offer: AutomationOffer): Automation? {
		val built = builtTrigger(offer) ?: return null
		val actions = steps.map { (it as? StepDraft.Do)?.action ?: return null }
		if (actions.isEmpty() || actions.any { actionIssue(it, offer) != null }) return null
		val written = actions.map { actionOf(it, offer) ?: return null }
		return Automation(label = original?.label, enabled = enabled, trigger = built, actions = written)
	}

	fun changedFrom(opened: AutomationDraft): Boolean =
		trigger != opened.trigger || unkeyed(steps) != unkeyed(opened.steps) || enabled != opened.enabled || runs != opened.runs
}

/** A crossing of that device's first number; null when not offered. */
private fun watchTrigger(device: String, offer: AutomationOffer, zone: String): TriggerDraft? {
	val watched = offer.copy(numbers = offer.numbers.filter { it.device == device })
	if (!offersChoice(watched, TriggerChoice.CROSSING, sources = false)) return null
	return freshTrigger(TriggerChoice.CROSSING, watched, null, zone)
}

/** First offered trigger and action, or a crossing; null if none. */
internal fun newAutomationDraft(
	context: EditContext,
	zone: String = "",
	watch: String? = null,
	display: String? = null,
): AutomationDraft? {
	val offer = context.offer
	val sources = context.sources
	val firstSource = sources.firstOrNull { it.triggers }?.id
	val trigger = if (watch != null) {
		watchTrigger(watch, offer, zone)
	} else {
		TriggerChoice.entries
			.filter { offersChoice(offer, it, firstSource != null) }
			.firstNotNullOfOrNull { freshTrigger(it, offer, firstSource, zone) }
	} ?: return null
	val action = addableActions(offer, emptyList()).firstNotNullOfOrNull { freshAction(it.kind, offer) } ?: return null
	return AutomationDraft(
		id = "auto-${java.util.UUID.randomUUID()}",
		trigger = trigger,
		steps = listOf(StepDraft.Do(freshKey(), action)),
		enabled = true,
		revision = 0L,
		context = context,
		display = display,
	)
}

/** Null draws a spinner. */
internal fun unopenedLine(slot: AutomationSlot, standing: EditStanding): String? = when {
	standing != EditStanding.READY -> waitingLine(standing)
	slot is AutomationSlot.New -> "This Gateway has nothing an automation could start from."
	else -> "This automation is not edited here."
}

/** Null for a trigger the editor does not draw. */
internal fun automationDraftOf(row: AutomationRow, context: EditContext, display: String? = null): AutomationDraft? {
	val offer = context.offer
	val trigger = triggerDraftOf(row.automation.trigger, offer, display) ?: return null
	val draft = AutomationDraft(
		id = row.id,
		trigger = trigger,
		steps = written(row.automation).map { action -> StepDraft.Do(freshKey(), actionDraftOf(action, offer)) },
		enabled = row.automation.enabled,
		revision = row.revision,
		context = context,
		original = row.automation,
		display = display,
	)
	// Functions only where served.
	val functions = offer.functions ?: return draft
	return draft.withRuns(runsDraftOf(row.id, row.automation, functions.rows, offer))
}

/** The draft's source's fields. */
internal fun fieldsOf(draft: AutomationDraft, sources: List<AssistantSource>): SourceFields =
	SourceFields(sources.find { it.id == draft.source }?.fieldSpecs.orEmpty())

internal fun fittingAutomation(draft: AutomationDraft, fields: SourceFields, offer: AutomationOffer): Automation? =
	draft.toAutomation(offer)?.takeIf { draft.conditions.all { condition -> fields.issueOf(condition) == null } }

/** What its trigger gives a function. */
internal fun givenOf(draft: AutomationDraft, fields: SourceFields): TriggerGiven =
	triggerGiven(draft.trigger.kind, eventFields = fields.specs.map { it.field })

/** A crossing's measure; null otherwise. */
internal fun measureOf(draft: AutomationDraft): String? = (draft.trigger as? TriggerDraft.Crossing)?.measure?.takeIf { it.isNotBlank() }

/** What blocks Save in its Runs block; null where functions are not served. */
internal fun draftRunsIssue(draft: AutomationDraft, fields: SourceFields, offer: AutomationOffer): RunsIssue? {
	if (offer.functions == null) return null
	return runsIssue(draft.runsDraft(), draft.id, givenOf(draft, fields), offer)
}

/** The save op; null when unservable or unwritable. */
internal fun functionSaveOf(
	draft: AutomationDraft,
	fields: SourceFields,
	offer: AutomationOffer,
	confirmed: Boolean,
): ConsoleOp.AutomationSave? {
	if (offer.functions == null) return null
	val built = draft.builtTrigger(offer) ?: return null
	if (draft.conditions.any { fields.issueOf(it) != null } || draftRunsIssue(draft, fields, offer) != null) return null
	return saveOpOf(draft.id, draft.revision, draft.runsDraft(), offer, confirmed) { actions ->
		Automation(label = draft.original?.label, enabled = draft.enabled, trigger = built, actions = actions)
	}
}

/** A function id as the editor mints one. */
internal fun freshFunctionId(): String = "fn-${java.util.UUID.randomUUID()}"

/** The trigger a preview asks about; null while it could not be saved here. */
internal fun askedTrigger(
	draft: AutomationDraft,
	fields: SourceFields,
	sources: List<AssistantSource>,
	offer: AutomationOffer,
): AutomationTrigger? =
	draft.builtTrigger(offer)?.takeIf {
		triggerOffered(draft, sources, offer) && draft.conditions.all { condition -> fields.issueOf(condition) == null }
	}

internal fun openedDraft(
	slot: AutomationSlot,
	held: Lookup<AutomationRow>?,
	context: EditContext,
	display: String? = null,
	zone: String = "",
): AutomationDraft? = when (slot) {
	is AutomationSlot.Held ->
		openingDraft(held, { null }) { row -> row.takeIf { editable(it, context.offer) }?.let { automationDraftOf(it, context, display) } }
	is AutomationSlot.New -> newAutomationDraft(context, zone, slot.watch, display)
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
	offer: AutomationOffer,
	checkSaid: AutomationSaid? = null,
	said: AutomationSaid? = null,
): AutomationEditing {
	val edit = !busy && !gone
	return AutomationEditing(
		edit = edit,
		save = edit && offered && saveAllowedAfterCheck(checkSaid, said, draft.runsDraft()) && if (offer.functions != null) {
			functionSaveOf(draft, fields, offer, confirmed = false) != null
		} else {
			fittingAutomation(draft, fields, offer) != null
		},
		delete = edit && slot is AutomationSlot.Held,
	)
}

/** Refusal blocks; movement too. */
internal fun saveAllowedAfterCheck(checkSaid: AutomationSaid?, said: AutomationSaid?, runs: RunsDraft): Boolean =
	checkSaid == null && !movedFor(said, runs)

/** Drawn as an error. */
internal fun saidRefuses(said: AutomationSaid?): Boolean = said != null && said !is AutomationSaid.Note

/** The function Reload replaces. */
internal fun reloadable(runs: RunsDraft): String? =
	(runs as? RunsDraft.Pointing)?.takeIf { it.mode == PointMode.SHARED || it.mode == PointMode.UNIQUE }?.functionId

/** Moved function remains selected. */
internal fun movedFor(said: AutomationSaid?, runs: RunsDraft): Boolean =
	said is AutomationSaid.FunctionMoved && said.functionId == reloadable(runs)

/** Null retains held check. */
internal fun checkAfter(held: CheckRead, asked: ConsoleOp.AutomationSave, answer: ConsoleAutomationCheckResult?): CheckRead =
	answer?.let { CheckRead(asked, it) } ?: held

/** An event needs its source; other kinds need the Gateway to hold them. */
internal fun triggerOffered(draft: AutomationDraft, sources: List<AssistantSource>, offer: AutomationOffer): Boolean =
	when (val trigger = draft.trigger) {
		is TriggerDraft.Event -> sources.any { it.id == trigger.source && it.triggers }
		else -> offer.holds(trigger.kind)
	}


internal data class AutomationGroup(
	val gatewayId: String,
	val assistant: Boolean,
	val rows: List<AutomationRow>,
	val context: AutomationContext,
)

internal fun automationGroups(registry: GatewayRegistry, home: AssistantHome): List<AutomationGroup> =
	registry.gateways
		.listedGroups { it.automations }
		.map {
			val context = automationContext(registry, home, it.gatewayId)
			AutomationGroup(it.gatewayId, placedOn(home) == it.gatewayId, it.rows, context)
		}
		.sortedByDescending { it.assistant }

private fun placedOn(home: AssistantHome): String? = when (home) {
	AssistantHome.Unread -> null
	is AssistantHome.Read -> home.record?.gatewayId
}

/** Null while a group is drawn; the home's build outranks the rest. */
internal fun automationsEmpty(registry: GatewayRegistry, home: String?): ListEmpty? {
	val empty = groupedView(registry, registry.gateways) { it.automations }.empty ?: return null
	val notServed = home != null && registry.entry(home)?.automations == GatewayList.NotServed
	return if (registry.loaded && notServed) ListEmpty.NotServed(listOf(home!!)) else empty
}

/** Needs a trigger the Gateway holds; undrawable actions are kept. */
internal fun editable(row: AutomationRow, offer: AutomationOffer): Boolean {
	val trigger = triggerDraftOf(row.automation.trigger, offer, null) ?: return false
	return offer.holds(trigger.kind)
}

internal sealed interface AutomationSaid {
	val line: String

	data class Line(override val line: String) : AutomationSaid

	/** Told, not refused. */
	data class Note(override val line: String) : AutomationSaid

	/** Dangerous actions to confirm. */
	data class Confirm(val labels: List<String>) : AutomationSaid {
		override val line get() = "It needs your go-ahead: ${labels.joinToString(", ")}"
	}

	/** A text's hole the Gateway cannot keep. */
	data class Hole(
		/** The card's key. */
		val key: String,
		val param: String,
		val start: Int,
		val end: Int,
		override val line: String,
		/** As it was sent. */
		val text: String,
	) : AutomationSaid

	/** Under its row or field. */
	data class Field(
		val at: SaidAt,
		override val line: String,
		/** As it was sent. */
		val text: String,
	) : AutomationSaid

	data class FunctionMoved(val functionId: String) : AutomationSaid {
		override val line get() = FUNCTION_MOVED_LINE
	}
}

internal data class CheckRead(
	val op: ConsoleOp.AutomationSave? = null,
	val answer: ConsoleAutomationCheckResult? = null,
)

internal fun checkedFor(read: CheckRead, op: ConsoleOp.AutomationSave?): ConsoleAutomationCheckResult? =
	read.answer?.takeIf { op != null && read.op == op }

internal fun checkedReads(read: CheckRead, functionId: String): FunctionReads? {
	val automation = read.op?.automation ?: return null
	return read.answer?.reads?.takeIf { pointerOf(automation) == functionId }
}

internal fun checkSaidOf(check: ConsoleAutomationCheckResult?, draft: AutomationDraft, context: EditContext): AutomationSaid? {
	if (check == null || check.ready) return null
	val refusal = check.refusal ?: return null
	if (refusal.code == Protocol.Wire.AutomationSaveRefusalCode.CONFIRM.wire) return null
	if (
		refusal.code == Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire &&
		refusal.record == Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire
	) return null
	val saved = automationSavedOf(
		ConsoleAutomationSaveResult(stored = false, refusal = refusal),
		draft.id,
	)
	return when (val outcome = outcomeOf(saved, draft, deleting = false, context)) {
		is AutomationOutcome.Said -> outcome.said
		AutomationOutcome.Done, is AutomationOutcome.Offer -> null
	}
}

/** Where a refusal lands. */
internal sealed interface SaidAt {
	/** A function value's row. */
	data class Value(val param: String) : SaidAt

	/** A card's field, by the card's key. */
	data class Card(val key: String, val param: String) : SaidAt
}

/** Null for a step no card holds. */
internal fun saidAtOf(at: RefusedAt, draft: AutomationDraft): SaidAt? = when (at) {
	is RefusedAt.Value -> SaidAt.Value(at.param)
	is RefusedAt.Step -> keyAt(draft.steps, at.path)?.let { SaidAt.Card(it, at.param) }
}

internal sealed interface AutomationOutcome {
	data object Done : AutomationOutcome
	data class Offer(val draft: AutomationDraft, val line: String) : AutomationOutcome
	data class Said(val said: AutomationSaid) : AutomationOutcome {
		constructor(reason: String) : this(AutomationSaid.Line(reason))
	}
}

internal fun outcomeOf(
	saved: AutomationSaved,
	draft: AutomationDraft,
	deleting: Boolean,
	context: EditContext,
): AutomationOutcome =
	when (saved) {
		is AutomationSaved.Stored -> AutomationOutcome.Done
		AutomationSaved.Unreachable -> AutomationOutcome.Said("That Gateway could not be reached")
		is AutomationSaved.Refused -> {
			val held = saved.heldRow?.takeIf { it.id == draft.id && it.revision != draft.revision && editable(it, context.offer) }
			val hole = saved.hole?.let { refused -> keyAt(draft.steps, refused.path)?.let { key -> key to refused } }
			val at = saved.at?.let { saidAtOf(it, draft) }
			val moved = reloadable(draft.runsDraft()).takeIf { saved.functionMoved }
			when {
				moved != null -> AutomationOutcome.Said(AutomationSaid.FunctionMoved(moved))
				saved.confirm.isNotEmpty() -> AutomationOutcome.Said(AutomationSaid.Confirm(saved.confirm))
				at != null -> AutomationOutcome.Said(AutomationSaid.Field(at, saved.reason, saidText(draft, at)))
				hole != null -> AutomationOutcome.Said(
					AutomationSaid.Hole(
						hole.first,
						hole.second.param,
						hole.second.start,
						hole.second.end,
						saved.reason,
						saidText(draft, SaidAt.Card(hole.first, hole.second.param)),
					),
				)
				held == null -> AutomationOutcome.Said(saved.reason)
				deleting -> AutomationOutcome.Offer(
					automationDraftOf(held, context, draft.display) ?: draft,
					"It changed elsewhere; this is it now. Delete again to delete it.",
				)
				else -> AutomationOutcome.Offer(
					draft.copy(revision = held.revision, original = held.automation, enabled = held.automation.enabled),
					"It changed elsewhere. Save again to go over it.",
				)
			}
		}
	}

/** A clock's next slot outranks its last run. */
internal fun ranText(row: AutomationRow, ago: (Long) -> String, until: (Long) -> String = { "soon" }): String =
	row.nextRunAt?.let { "Next ${until(it)}" } ?: row.lastRanAt?.let { "Ran ${ago(it)}" } ?: "Never ran"

/** "4 use this source". */
internal fun usesText(count: Int): String = if (count == 1) "1 uses this source" else "$count use this source"

/** "reason, type, repository". */
internal fun producesText(specs: List<AssistantFieldSpec>): String =
	specs.joinToString(", ") { spec -> spec.label.replaceFirstChar { it.lowercase() } }

/** Null for no recent events. */
internal fun previewHead(preview: ConsoleAutomationPreviewResult): String? =
	if (preview.of == 0L) null else "Would have matched ${preview.matched} of the last ${preview.of}"
