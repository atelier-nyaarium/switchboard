package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.AssistantHome
import com.atelier_nyaarium.switchboard.AutomationSaved
import com.atelier_nyaarium.switchboard.MovedFunction
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
import com.atelier_nyaarium.switchboard.RunState
import com.atelier_nyaarium.switchboard.runLine
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationCheckResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.AutomationConditionServes
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationIssueLevel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal val MAX_CONDITIONS = Protocol.Wire.ASSISTANT_RULE_CONDITIONS_MAX
private val MAX_VALUE_LEN = Protocol.Wire.ASSISTANT_RULE_VALUE_MAX
private val MAX_VALUES = Protocol.Wire.CONDITION_VALUES_MAX
private val ASCII_EDGES = setOf(0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D)

// skew:condition-lists
/** Fallback tests without listing. */
private val UNLISTED_TESTS = listOf("is", "is_not", "contains")

internal fun trimRuleValue(value: String): String = value.trim { it.code in ASCII_EDGES }

private fun sameValue(a: String, b: String): Boolean = a.lowercase() == b.lowercase()

internal fun valuesOf(condition: AutomationCondition): List<String> = when (val value = condition.value) {
	is JsonArray -> value.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
	is JsonPrimitive -> listOfNotNull(value.contentOrNull)
	is JsonObject -> emptyList()
}.filter { trimRuleValue(it).isNotEmpty() }

internal fun conditionOf(field: String, test: String, values: List<String>): AutomationCondition {
	val kept = values.map(::trimRuleValue).filter { it.isNotEmpty() }.distinct()
	val value = when (kept.size) {
		0 -> JsonPrimitive("")
		1 -> JsonPrimitive(kept.single())
		else -> JsonArray(kept.map(::JsonPrimitive))
	}
	return AutomationCondition(field, test, value)
}

internal fun testLabel(test: String, values: Int = 1): String =
	(if (values > 1) FieldTypes.LIST_TEST_LABELS else FieldTypes.TEST_LABELS)[test] ?: test

internal fun servedTests(served: AutomationConditionServes?): List<String> = served?.tests ?: UNLISTED_TESTS

internal fun valuesMax(served: AutomationConditionServes?): Int = served?.values?.toInt()?.coerceIn(1, MAX_VALUES) ?: 1

internal fun conditionsServed(conditions: List<AutomationCondition>, served: AutomationConditionServes?): Boolean =
	conditions.all { valuesOf(it).size <= valuesMax(served) && it.test in servedTests(served) }

internal fun addsValue(condition: AutomationCondition, served: AutomationConditionServes?): Boolean =
	valuesOf(condition).size < valuesMax(served)

internal fun valueRefusal(condition: AutomationCondition, typed: String, served: AutomationConditionServes?): String? {
	val value = trimRuleValue(typed)
	val held = valuesOf(condition)
	return when {
		value.isEmpty() -> null
		value.length > MAX_VALUE_LEN -> "At most $MAX_VALUE_LEN characters"
		held.any { sameValue(it, value) } -> "Already listed"
		!addsValue(condition, served) -> "At most ${valuesMax(served)} values"
		else -> null
	}
}

internal fun valueAddable(condition: AutomationCondition, typed: String, served: AutomationConditionServes?): Boolean =
	trimRuleValue(typed).isNotEmpty() && valueRefusal(condition, typed, served) == null

internal sealed interface ValueAdd {
	data object Full : ValueAdd

	data class Pick(val choices: List<String>) : ValueAdd

	data object Type : ValueAdd
}

internal fun valueAddOf(condition: AutomationCondition, fields: SourceFields, served: AutomationConditionServes?): ValueAdd {
	if (!addsValue(condition, served)) return ValueAdd.Full
	val choices = fields.choicesFor(condition) ?: return ValueAdd.Type
	return if (choices.isEmpty()) ValueAdd.Full else ValueAdd.Pick(choices)
}

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

	fun choicesFor(condition: AutomationCondition): List<String>? {
		val offered = (specOf(condition.field) as? AssistantFieldSpec.Enumeration)?.options?.map { it.value } ?: return null
		val held = valuesOf(condition)
		return offered.filter { it !in held }
	}

	fun testsFor(condition: AutomationCondition, served: AutomationConditionServes?): List<String> {
		val offered = testsOf(specOf(condition.field)).filter { it in servedTests(served) }
		return if (condition.test in offered) offered else listOf(condition.test) + offered
	}

	fun issueOf(condition: AutomationCondition): CardIssue? {
		val spec = specOf(condition.field)
			?: return CardIssue(AutomationIssueLevel.UNARMED, "${fieldLabel(condition.field)} is not a field here")
		val values = valuesOf(condition).map(::trimRuleValue)
		if (values.isEmpty()) return null
		if (values.any { it.length > MAX_VALUE_LEN }) return CardIssue(AutomationIssueLevel.ERROR, "At most $MAX_VALUE_LEN characters")
		if (values.size > MAX_VALUES) return CardIssue(AutomationIssueLevel.ERROR, "At most $MAX_VALUES values")
		if (condition.test !in testsOf(spec)) {
			return CardIssue(AutomationIssueLevel.UNARMED, "${spec.label} takes no \"${testLabel(condition.test, values.size)}\"")
		}
		val gone = (spec as? AssistantFieldSpec.Enumeration)?.let { held -> values.firstOrNull { value -> held.options.none { it.value == value } } }
		return gone?.let { CardIssue(AutomationIssueLevel.WARNING, "no longer offered; it matches nothing", it) }
	}

	/** Vanished choices remain valid. */
	fun fits(condition: AutomationCondition): Boolean =
		valuesOf(condition).isNotEmpty() && issueOf(condition)?.let { !drawsAsError(it.level) } != false
}

internal data class CalleeDraft(
	val id: String,
	/** `0` means new. */
	val base: Long,
	val name: String,
	val params: List<FunctionValueDraft>,
	val steps: List<StepDraft>,
	val original: AutomationFunction?,
	/** Opened cards without keys. */
	val opened: List<StepDraft>,
	val script: ScriptEdit? = null,
	/** Shown as script. */
	val scripted: Boolean = false,
) {
	fun edited(): Boolean = base == 0L || unkeyed(steps) != opened || script?.unread() == true

	/** A re-read of its row would drop it. */
	fun heldOverRow(): Boolean = edited() || script?.typed() == true

	/** An empty new one holds none. */
	fun holdsWork(): Boolean = edited() && !(base == 0L && steps.isEmpty())
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
	/** Blank uses Gateway default. */
	val keepTryingMin: String = "",
	val callees: Map<String, CalleeDraft> = emptyMap(),
	/** Innermost page last. */
	val inside: List<String> = emptyList(),
	val script: ScriptEdit? = null,
	/** Own script mode. */
	val scripted: Boolean = false,
	/** Open script page. */
	val scriptPage: ScriptPage? = null,
) {
	fun runsDraft(): RunsDraft = runsOf(runs, steps)

	/** Same tree, edited: its script state stays. */
	fun withRuns(next: RunsDraft): AutomationDraft = headOf(next).let { (head, cards) -> copy(runs = head, steps = cards) }

	/**
	 * The one swap of its own tree for another body. Script state comes from the new cards unless
	 * `carried`, and a page open into the old tree closes.
	 */
	fun swappedOwn(next: RunsDraft, carried: ScriptEdit? = null, carriedScripted: Boolean = false): AutomationDraft {
		val (head, cards) = headOf(next)
		val script = carried ?: scriptOfCards(cards)
		return copy(
			runs = head,
			steps = cards,
			script = script,
			scripted = if (carried != null) carriedScripted else script != null,
			text = text?.takeIf { findStep(steps, it.key) == null },
			scriptPage = scriptPage?.takeIf { it.tree != null },
		)
	}

	/** The one swap of a callee's body; a page open into the old one closes. */
	private fun swappedCallee(next: CalleeDraft): AutomationDraft = copy(
		callees = callees + (next.id to next),
		text = text?.takeIf { treeHolding(it.key) != next.id },
		scriptPage = scriptPage?.takeIf { it.tree != next.id },
	)

	private val event: TriggerDraft.Event? get() = trigger as? TriggerDraft.Event

	/** Blank unless an event triggers it. */
	val source: String get() = event?.source.orEmpty()

	val conditionDrafts: List<ConditionDraft> get() = event?.conditions.orEmpty()

	val conditions: List<AutomationCondition> get() = conditionDrafts.map { it.condition }

	private fun onEvent(change: (TriggerDraft.Event) -> TriggerDraft.Event): AutomationDraft =
		event?.let { copy(trigger = change(it)) } ?: this

	fun withCondition(fields: SourceFields): AutomationDraft {
		if (conditions.size >= MAX_CONDITIONS) return this
		val spec = fields.specs.firstOrNull { testsOf(it).isNotEmpty() } ?: return this
		val test = testsOf(spec).first()
		return onEvent { it.copy(conditions = it.conditions + ConditionDraft(freshKey(), conditionOf(spec.field, test, emptyList()))) }
	}

	fun withField(key: String, field: String, fields: SourceFields): AutomationDraft {
		val held = conditionDrafts.firstOrNull { it.key == key }?.condition ?: return this
		if (field == held.field) return this
		val was = fields.specOf(held.field)
		val now = fields.specOf(field)
		val keepsValues = was is AssistantFieldSpec.Text && now is AssistantFieldSpec.Text
		val test = held.test.takeIf { it in testsOf(now) } ?: testsOf(now).firstOrNull() ?: held.test
		return changed(key, field = field, test = { test }, values = { if (keepsValues) it else emptyList() })
	}

	fun withoutCondition(key: String): AutomationDraft =
		onEvent { it.copy(conditions = it.conditions.filter { held -> held.key != key }) }

	fun changed(
		key: String,
		field: String? = null,
		test: (String) -> String = { it },
		values: (List<String>) -> List<String> = { it },
	): AutomationDraft = onEvent { event ->
		event.copy(
			conditions = event.conditions.map { draft ->
				val held = draft.condition
				if (draft.key == key) draft.copy(condition = conditionOf(field ?: held.field, test(held.test), values(valuesOf(held)))) else draft
			},
		)
	}

	fun withSource(source: String): AutomationDraft = onEvent { it.copy(source = source, conditions = emptyList()) }

	fun withEventCoolDown(typed: String): AutomationDraft = onEvent { it.copy(coolDownMin = typed) }

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

	/** Keys span all trees. */
	fun stepAt(key: String): StepDraft? =
		findStep(steps, key) ?: callees.values.firstNotNullOfOrNull { findStep(it.steps, key) }

	fun cardsOf(function: String?): List<StepDraft>? = when (function) {
		null, functionHere(this, null) -> steps
		else -> callees[function]?.steps
	}

	/** Null selects own cards. */
	fun stepsOf(tree: String?): List<StepDraft> = if (tree == null) steps else callees[tree]?.steps.orEmpty()

	/** Null: root or missing. */
	fun treeHolding(key: String): String? = callees.values.firstOrNull { findStep(it.steps, key) != null }?.id

	private fun withTree(tree: String?, list: List<StepDraft>): AutomationDraft =
		if (tree == null) copy(steps = list) else callees[tree]?.let { copy(callees = callees + (tree to it.copy(steps = list))) } ?: this

	/** The card at `key` changed. */
	fun withStep(key: String, change: (StepDraft) -> StepDraft): AutomationDraft = copy(
		steps = replacedStep(steps, key, change),
		callees = callees.mapValues { (_, callee) -> callee.copy(steps = replacedStep(callee.steps, key, change)) },
	)

	/** The action of the card at `key` changed. */
	fun withAction(key: String, change: (ActionDraft) -> ActionDraft): AutomationDraft =
		withStep(key) { step -> if (step is StepDraft.Do) step.copy(action = change(step.action)) else step }

	fun withSwitch(key: String, change: (StepDraft.Switch) -> StepDraft.Switch?): AutomationDraft =
		withStep(key) { step -> (step as? StepDraft.Switch)?.let(change) ?: step }

	/** Statements mint function IDs. */
	fun plusStep(slot: Slot, step: StepDraft, tree: String? = null): AutomationDraft {
		val into = if (slot.parent != null) treeHolding(slot.parent) else tree
		val placed = insertedStep(stepsOf(into), slot, step) ?: return this
		if (into != null) return withTree(into, placed)
		val minted = if (step is StepDraft.Do) newFunctionId else newFunctionId ?: freshFunctionId()
		return copy(steps = placed, newFunctionId = minted)
	}

	fun plusAction(action: ActionDraft): AutomationDraft = plusStep(Slot(null, null, steps.size), StepDraft.Do(freshKey(), action))

	fun minusStep(key: String): AutomationDraft = copy(
		steps = removedStep(steps, key),
		callees = callees.mapValues { (_, callee) -> callee.copy(steps = removedStep(callee.steps, key)) },
	)

	fun plusElseIf(head: String): AutomationDraft {
		val tree = treeHolding(head)
		return withElseIf(stepsOf(tree), head)?.let { withTree(tree, it) } ?: this
	}

	fun minusLink(link: String): AutomationDraft {
		val tree = treeHolding(link)
		return withTree(tree, withoutLink(stepsOf(tree), link))
	}

	fun movedTo(key: String, slot: Slot): AutomationDraft {
		val tree = treeHolding(key)
		return movedStep(stepsOf(tree), key, slot)?.let { withTree(tree, it) } ?: this
	}

	/** Read callee once. */
	fun openedCallee(id: String, offer: AutomationOffer): AutomationDraft {
		val row = offer.functions?.row(id)
		val held = callees[id]
		// An untouched copy follows its row.
		if (held != null && (held.heldOverRow() || row == null || row.revision == held.base)) return copy(inside = inside + id)
		row ?: return this
		return swappedCallee(calleeOf(row, offer)).let { it.copy(inside = it.inside + id) }
	}

	/** Untouched copies whose row moved, read again. */
	fun freshened(offer: AutomationOffer): AutomationDraft {
		val moved = callees.values.mapNotNull { held ->
			offer.functions?.row(held.id)?.takeIf { !held.heldOverRow() && it.revision != held.base }
		}
		return moved.fold(this) { draft, row -> draft.swappedCallee(calleeOf(row, offer)) }
	}

	/** True means edits dropped. */
	fun reloadedCallee(row: AutomationFunctionRow, offer: AutomationOffer): Pair<AutomationDraft, Boolean> {
		val held = callees[row.id] ?: return this to false
		return swappedCallee(calleeOf(row, offer)) to held.edited()
	}

	fun withNewCallee(key: String, name: String): AutomationDraft {
		val id = freshFunctionId()
		val callee = CalleeDraft(id, 0L, name.trim(), emptyList(), emptyList(), null, emptyList())
		return copy(callees = callees + (id to callee)).withStep(key) { step ->
			(step as? StepDraft.Call)?.copy(function = id, values = emptyMap()) ?: step
		}
	}

	fun builtTrigger(offer: AutomationOffer): AutomationTrigger? {
		val built = triggerOf(trigger, offer, display) ?: return null
		val unfit = built is AutomationTrigger.Event && built.conditions.any { condition ->
			valuesOf(condition).let { values -> values.size > MAX_VALUES || values.any { it.length > MAX_VALUE_LEN } }
		}
		return built.takeUnless { unfit }
	}

	/** Null while the trigger or an action cannot be saved. */
	fun toAutomation(offer: AutomationOffer): Automation? {
		val built = builtTrigger(offer) ?: return null
		val actions = steps.map { (it as? StepDraft.Do)?.action ?: return null }
		if (actions.isEmpty() || actions.any { actionIssue(it, offer) != null }) return null
		val written = actions.map { actionOf(it, offer) ?: return null }
		return automationOf(built, written)
	}

	/** Null for invalid settings. */
	fun automationOf(trigger: AutomationTrigger, actions: List<AutomationAction>): Automation? {
		if (settingsIssue(this) != null) return null
		return Automation(
			label = original?.label,
			enabled = enabled,
			trigger = trigger,
			actions = actions,
			keepTryingMin = keepTryingMin.takeIf { it.isNotBlank() }?.trim()?.toLong(),
		)
	}

	fun changedFrom(opened: AutomationDraft): Boolean =
		unkeyed(trigger) != unkeyed(opened.trigger) ||
			unkeyed(steps) != unkeyed(opened.steps) ||
			enabled != opened.enabled ||
			runs != opened.runs ||
			keepTryingMin != opened.keepTryingMin ||
			script?.unread() == true ||
			callees.values.any { it.holdsWork() }
}

/** Changes when an answer, not typing, replaces bodies. */
internal fun mirrorKey(draft: AutomationDraft): Any =
	Triple(draft.revision, (draft.runsDraft() as? RunsDraft.Pointing)?.base, draft.callees.mapValues { it.value.base })

/** Calls include kept cards. */
internal fun callTargets(steps: List<StepDraft>): List<String> = everyStep(steps).flatMap { step ->
	when (step) {
		is StepDraft.Call -> listOf(step.function)
		is StepDraft.Kept -> callsIn(listOf(step.step))
		is StepDraft.Do, is StepDraft.If, is StepDraft.Try, is StepDraft.Switch, is StepDraft.Wait, is StepDraft.Exit, is StepDraft.Note -> emptyList()
	}
}.filter { it.isNotBlank() }

/** The one callee reader. */
internal sealed interface FunctionSource {
	val params: List<FunctionParam>
	val calls: List<String>

	/** Own cards, or an edited callee's. */
	data class Cards(override val params: List<FunctionParam>, val steps: List<StepDraft>, val callee: CalleeDraft?) : FunctionSource {
		override val calls get() = callTargets(steps)
	}

	/** Else the listed row; never an untouched copy. */
	data class Listed(val row: AutomationFunctionRow) : FunctionSource {
		override val params get() = row.function.params
		override val calls get() = callsOf(row.function)
	}
}

internal fun functionSource(draft: AutomationDraft, offer: AutomationOffer, id: String): FunctionSource? {
	if (id == functionHere(draft, null)) {
		val params = (draft.runs as? RunsHead.Points)?.pointing?.params?.map { it.param }.orEmpty()
		return FunctionSource.Cards(params, draft.steps, null)
	}
	draft.callees[id]?.takeIf { it.edited() }?.let { return FunctionSource.Cards(it.params.map { value -> value.param }, it.steps, it) }
	return offer.functions?.row(id)?.let(FunctionSource::Listed)
}

/** Starts included. */
internal fun AutomationDraft.reached(starts: Collection<String>, offer: AutomationOffer): Set<String> =
	reachOver(starts) { id -> functionSource(this, offer, id)?.calls.orEmpty() }

/** Edited callees the automation still reaches. */
internal fun sentCallees(draft: AutomationDraft, offer: AutomationOffer): List<CalleeDraft> {
	val reached = draft.reachedCallees(offer)
	return draft.callees.values.filter { it.id in reached && it.edited() }
}

internal fun calleeParamsOf(draft: AutomationDraft, offer: AutomationOffer): CalleeParams = { id -> functionSource(draft, offer, id)?.params }

/** Edited callees a save leaves behind. */
internal fun droppedEdits(draft: AutomationDraft, offer: AutomationOffer): List<CalleeDraft> {
	val reached = draft.reachedCallees(offer)
	return draft.callees.values.filter { it.holdsWork() && it.id !in reached }
}

internal fun droppedLine(dropped: List<CalleeDraft>): String? =
	dropped.takeIf { it.isNotEmpty() }?.let { list -> "Edits to ${list.joinToString(", ") { it.name }} are not saved: nothing calls it now." }

/** Automation's reached callees. */
internal fun AutomationDraft.reachedCallees(offer: AutomationOffer): Set<String> =
	reached(callTargets(steps), offer).filterTo(mutableSetOf()) { it in callees }

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
		keepTryingMin = row.automation.keepTryingMin?.toString().orEmpty(),
	)
	// Functions only where served.
	val functions = offer.functions ?: return draft
	return draft.swappedOwn(runsDraftOf(row.id, row.automation, functions.rows, offer))
}

/** The draft's source's fields. */
internal fun fieldsOf(draft: AutomationDraft, sources: List<AssistantSource>): SourceFields =
	SourceFields(sources.find { it.id == draft.source }?.fieldSpecs.orEmpty())

/** Wire parse only. */
internal fun fittingAutomation(draft: AutomationDraft, offer: AutomationOffer): Automation? = draft.toAutomation(offer)

/** What its trigger gives a function. */
internal fun givenOf(draft: AutomationDraft, fields: SourceFields): TriggerGiven =
	triggerGiven(draft.trigger.kind, eventFields = fields.specs.map { it.field })

/** A crossing's measure; null otherwise. */
internal fun measureOf(draft: AutomationDraft): String? = (draft.trigger as? TriggerDraft.Crossing)?.measure?.takeIf { it.isNotBlank() }

internal fun draftRunsIssue(draft: AutomationDraft, fields: SourceFields, offer: AutomationOffer): RunsIssue? {
	if (offer.functions == null) return null
	runsIssue(draft.runsDraft(), draft.id, givenOf(draft, fields), offer)?.let { return it }
	return sentCallees(draft, offer).firstOrNull { calleeIssue(it, offer) != null }?.let { RunsIssue.InCallee(it.name) }
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
	if (draftRunsIssue(draft, fields, offer) != null) return null
	return saveOpOf(draft.id, draft.revision, draft.runsDraft(), offer, confirmed, draft.newFunctionId, sentCallees(draft, offer), calleeParamsOf(draft, offer)) { actions ->
		draft.automationOf(built, actions)
	}
}

private val KEEP_TRYING = Protocol.Wire.KEEP_TRYING_MIN_MIN..Protocol.Wire.KEEP_TRYING_MIN_MAX

internal fun settingsIssue(draft: AutomationDraft): String? {
	val typed = draft.keepTryingMin.trim()
	if (typed.isEmpty()) return null
	return "Keep trying is ${KEEP_TRYING.first} to ${KEEP_TRYING.last} minutes".takeIf { typed.toIntOrNull() !in KEEP_TRYING }
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
		triggerOffered(draft, sources, offer) && draft.conditions.all(fields::fits)
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
	val standing = !busy && !gone
	val edit = standing && !holdsUnserved(draft.steps, offer)
	return AutomationEditing(
		edit = edit,
		save = edit && offered && !scriptPending(draft, offer) && !errorsUnkept(draft, offer) &&
			saveAllowedAfterCheck(checkSaid, said, draft, offer) && if (offer.functions != null) {
			functionSaveOf(draft, fields, offer, confirmed = false) != null
		} else {
			fittingAutomation(draft, offer) != null
		},
		delete = standing && slot is AutomationSlot.Held,
	)
}

internal fun runOffered(slot: AutomationSlot, gone: Boolean, draft: AutomationDraft, opened: AutomationDraft, busy: Boolean, state: RunState?): Boolean =
	slot is AutomationSlot.Held && !gone && !busy && state != RunState.Asking && !draft.changedFrom(opened)

internal fun runShown(state: RunState?, opening: Long): String? = when (state) {
	null -> null
	RunState.Asking -> "Starting"
	is RunState.Said -> runLine(state.ran).takeIf { state.opening == opening }
}

internal fun calleeOf(row: AutomationFunctionRow, offer: AutomationOffer): CalleeDraft {
	val params = row.function.params.map { FunctionValueDraft(java.util.UUID.randomUUID().toString(), it) }
	val cards = written(row.function).map { treeOf(it, offer, params) }
	val script = scriptOfCards(cards)
	return CalleeDraft(row.id, row.revision, row.function.name, params, cards, row.function, unkeyed(cards), script, script != null)
}

/** Refusal blocks; movement too. */
internal fun saveAllowedAfterCheck(checkSaid: AutomationSaid?, said: AutomationSaid?, draft: AutomationDraft, offer: AutomationOffer): Boolean =
	checkSaid == null && !movedFor(said, draft.runsDraft()) && movedCallee(said, draft, offer) == null

internal fun movedCallee(said: AutomationSaid?, draft: AutomationDraft, offer: AutomationOffer): String? =
	(said as? AutomationSaid.FunctionMoved)?.functionId?.takeIf { it in draft.reachedCallees(offer) }

/** Pointer or callee ID. */
internal fun movedIdOf(moved: MovedFunction, draft: AutomationDraft): String? {
	val pointed = reloadable(draft.runsDraft())
	return when {
		moved.id == null || moved.id == pointed -> pointed
		moved.id in draft.callees -> moved.id
		else -> null
	}
}

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

/** Only matching op's issues. */
internal fun checkIssuesOf(read: CheckRead, op: ConsoleOp.AutomationSave?, draft: AutomationDraft, offer: AutomationOffer): DrawnIssues? {
	val sent = op ?: return null
	val check = checkedFor(read, sent)?.takeIf { it.ready } ?: return null
	return drawnIssuesOf(check.issues.orEmpty(), draft, flat = pointerOf(sent.automation) == null, offer)
}

/** Issues alone refuse nothing. */
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
	is RefusedAt.Step -> draft.cardsOf(at.function)?.let { keyAt(it, at.path) }?.let { SaidAt.Card(it, at.param) }
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
			val hole = saved.hole?.let { refused -> draft.cardsOf(refused.function)?.let { keyAt(it, refused.path) }?.let { key -> key to refused } }
			val at = saved.at?.let { saidAtOf(it, draft) }
			val moved = saved.functionMoved?.let { movedIdOf(it, draft) }
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
