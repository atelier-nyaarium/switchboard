package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationActionOffer
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.ActionParamKind
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

internal const val ACTION_TELL = "tell_assistant"
internal const val MAX_ACTIONS = Protocol.Wire.AUTOMATION_ACTIONS_MAX

internal val PARAM_TEXT = ActionParamKind.TEXT.wire
internal val PARAM_WORD = ActionParamKind.WORD.wire
internal val PARAM_SWITCH = ActionParamKind.SWITCH.wire
internal val PARAM_CHOICE = ActionParamKind.CHOICE.wire
private val WORD = Regex("^[A-Za-z0-9_-]+$")
private const val KIND = "kind"
private const val HOME_ONLY = "Runs only where the assistant lives"

internal data class ParamOption(val value: String, val label: String)

internal data class ParamOffer(
	val name: String,
	val label: String,
	val kind: String,
	val max: Int? = null,
	val lines: Boolean = false,
	val optional: Boolean = false,
	val options: List<ParamOption> = emptyList(),
)

/** Null for a kind this build cannot read. */
internal val ParamOffer.paramKind: ActionParamKind? get() = ActionParamKind.entries.find { it.wire == kind }

/** Whether the action form draws it. */
internal fun drawn(kind: ActionParamKind): Boolean = when (kind) {
	ActionParamKind.TEXT, ActionParamKind.WORD, ActionParamKind.SWITCH, ActionParamKind.CHOICE -> true
	ActionParamKind.FUNCTION, ActionParamKind.VALUES -> false
}

internal data class ActionOffer(
	val kind: String,
	val label: String,
	val danger: Boolean,
	/** Does nothing away from the assistant's home. */
	val home: Boolean = false,
	val params: List<ParamOffer> = emptyList(),
) {
	/** False once a parameter is of a kind this build cannot draw. */
	val drawable: Boolean get() = params.all { param -> param.paramKind?.let(::drawn) == true }

	fun param(name: String): ParamOffer? = params.find { it.name == name }
}

internal fun actionOfferOf(row: AutomationActionOffer): ActionOffer = ActionOffer(
	kind = row.kind,
	label = row.label,
	danger = row.danger,
	home = row.home,
	params = row.params.map { param ->
		ParamOffer(
			name = param.name,
			label = param.label,
			kind = param.kind,
			max = param.max?.toInt(),
			lines = param.lines == true,
			optional = param.optional == true,
			options = param.options.orEmpty().map { ParamOption(it.value, it.label) },
		)
	},
)

internal sealed interface ActionDraft {
	val kind: String

	data class Filled(
		override val kind: String,
		val values: Map<String, String>,
		val references: Map<String, FunctionValueReference> = emptyMap(),
	) : ActionDraft

	/** One the editor cannot draw whole, kept as sent. */
	data class Kept(val action: AutomationAction) : ActionDraft {
		override val kind get() = kindOf(action)
	}
}

private fun jsonOf(action: AutomationAction): JsonObject = wireJson.encodeToJsonElement(AutomationAction.serializer(), action).jsonObject

internal fun kindOf(action: AutomationAction): String = (jsonOf(action)[KIND] as? JsonPrimitive)?.contentOrNull.orEmpty()

/** Kept unless its Gateway offers the kind and every key it holds is a parameter the row names, as text. */
internal fun actionDraftOf(action: AutomationAction, offer: AutomationOffer): ActionDraft {
	val json = jsonOf(action)
	val row = offer.action(kindOf(action))?.takeIf { it.drawable } ?: return ActionDraft.Kept(action)
	val held = json.filterKeys { it != KIND }
	val drawn = held.all { (key, value) -> row.param(key) != null && value is JsonPrimitive && value.isString }
	if (!drawn) return ActionDraft.Kept(action)
	return ActionDraft.Filled(row.kind, row.params.associate { it.name to (held[it.name] as? JsonPrimitive)?.contentOrNull.orEmpty() })
}

private fun paramIssue(param: ParamOffer, value: String, offer: AutomationOffer): String? = when {
	value.isBlank() -> "${param.label} is needed".takeUnless { param.optional }
	param.max != null && value.length > param.max -> "${param.label}: at most ${param.max} characters"
	param.kind == PARAM_WORD && !WORD.matches(value) -> "${param.label} is letters, digits, - and _"
	param.kind == PARAM_SWITCH && offer.switches.none { it.device == value } -> "${param.label} is no longer here; pick again"
	param.kind == PARAM_CHOICE && param.options.none { it.value == value } -> "${param.label}: pick one"
	else -> null
}

/** Holds a value its row lacks. */
private fun unnamed(action: ActionDraft.Filled, row: ActionOffer): Boolean =
	action.values.any { (key, value) -> value.isNotBlank() && row.param(key) == null }

private fun issueOf(action: ActionDraft, offer: AutomationOffer, blanks: Boolean, valueNames: Set<String>): String? = when (action) {
	is ActionDraft.Kept -> null
	is ActionDraft.Filled -> {
		val row = offer.action(action.kind)
		when {
			row == null -> "This Gateway no longer offers it"
			unnamed(action, row) -> "This Gateway no longer offers part of it"
			else -> row.params.firstNotNullOfOrNull { param ->
				val reference = action.references[param.name]
				if (reference != null) {
					when {
						param.kind != PARAM_SWITCH -> "${param.label} cannot use a value"
						reference.key !in valueNames -> "${reference.name} is no longer a value; pick again"
						else -> null
					}
				} else {
				val value = action.values[param.name].orEmpty()
				if (!blanks && value.isBlank()) null else paramIssue(param, value, offer)
				}
			}
		}
	}
}

internal fun actionIssue(action: ActionDraft, offer: AutomationOffer, valueNames: Set<String> = emptySet()): String? =
	issueOf(action, offer, blanks = true, valueNames = valueNames)

/** Silent about a parameter that is still blank. */
internal fun actionHint(action: ActionDraft, offer: AutomationOffer, valueNames: Set<String> = emptySet()): String? =
	issueOf(action, offer, blanks = false, valueNames = valueNames)

/** One field an action draws; `param` null is a value its row no longer names. */
internal data class ParamView(val param: ParamOffer?, val name: String, val value: String, val reference: FunctionValueReference? = null)

/** The row's parameters, then each stray value. */
internal fun actionFields(action: ActionDraft.Filled, offer: AutomationOffer): List<ParamView> {
	val row = offer.action(action.kind)
	val named = row?.params.orEmpty().map { ParamView(it, it.name, action.values[it.name].orEmpty(), action.references[it.name]) }
	val stray = action.values.filter { (key, value) -> value.isNotBlank() && row?.param(key) == null }
	return named + stray.map { (key, value) -> ParamView(null, key, value) }
}

internal fun withoutValue(action: ActionDraft, name: String): ActionDraft = when (action) {
	is ActionDraft.Filled -> action.copy(values = action.values - name, references = action.references - name)
	is ActionDraft.Kept -> action
}

/** The last card stays until its kind is gone. */
internal fun canRemove(draft: AutomationDraft, key: String, offer: AutomationOffer): Boolean {
	val step = draft.stepAt(key) ?: return false
	val gone = step is StepDraft.Do && offer.action(step.action.kind) == null
	return everyStep(draft.stepsOf(draft.treeHolding(key))).size > 1 || gone
}

/** Does nothing here: needs the home. */
internal fun homeOnly(kind: String, offer: AutomationOffer): Boolean = offer.away && offer.action(kind)?.home == true

/** Warns; never blocks a save. */
internal fun actionWarning(action: ActionDraft, offer: AutomationOffer): String? {
	val kind = when (action) {
		is ActionDraft.Filled -> action.kind
		is ActionDraft.Kept -> kindOf(action.action)
	}
	return HOME_ONLY.takeIf { homeOnly(kind, offer) }
}

/** A blank optional parameter is left out; null when the action does not read back or would drop a value. */
internal fun actionOf(action: ActionDraft, offer: AutomationOffer): AutomationAction? = when (action) {
	is ActionDraft.Kept -> action.action
	is ActionDraft.Filled -> offer.action(action.kind)?.takeUnless { unnamed(action, it) || action.references.isNotEmpty() }?.let { row ->
		val json = buildJsonObject {
			put(KIND, action.kind)
			for (param in row.params) {
				val value = action.values[param.name].orEmpty()
				if (!(param.optional && value.isBlank())) put(param.name, value)
			}
		}
		val built = runIsolated { wireJson.decodeFromJsonElement(AutomationAction.serializer(), json) }.getOrNull()
		// A parameter this build lacks goes raw.
		built?.let { if (jsonOf(it).keys == json.keys) it else AutomationAction.Unknown(action.kind, json) }
	}
}

/** Null when this Gateway cannot run such an action here, or holds nothing it could act on. */
internal fun freshAction(kind: String, offer: AutomationOffer): ActionDraft? {
	val row = offer.action(kind)?.takeIf { it.drawable && !(it.home && offer.away) } ?: return null
	val values = row.params.associate { param ->
		param.name to when (param.paramKind) {
			ActionParamKind.CHOICE -> param.options.firstOrNull()?.value.orEmpty()
			ActionParamKind.SWITCH -> offer.switches.firstOrNull()?.device ?: return null
			ActionParamKind.TEXT, ActionParamKind.WORD, ActionParamKind.FUNCTION, ActionParamKind.VALUES, null -> ""
		}
	}
	return ActionDraft.Filled(kind, values)
}

internal fun addableActions(offer: AutomationOffer, held: List<StepDraft>): List<ActionOffer> =
	if (held.size >= MAX_ACTIONS) emptyList() else offer.actions.filter { freshAction(it.kind, offer) != null }

internal fun withValue(action: ActionDraft, param: String, value: String): ActionDraft = when (action) {
	is ActionDraft.Filled -> action.copy(values = action.values + (param to value), references = action.references - param)
	is ActionDraft.Kept -> action
}

internal fun withReference(action: ActionDraft, param: String, reference: FunctionValueReference): ActionDraft = when (action) {
	is ActionDraft.Filled -> action.copy(values = action.values + (param to ""), references = action.references + (param to reference))
	is ActionDraft.Kept -> action
}

/** A flat row's text. */
internal fun doesLine(action: ActionDraft, kind: String, offer: AutomationOffer): String =
	actionLineOf(action, kind, offer) + if (homeOnly(kind, offer)) " (only where the assistant lives)" else ""

/** Its label, then what its choices, switch and words are set to. */
private fun actionLineOf(action: ActionDraft, kind: String, offer: AutomationOffer): String {
	val draft = action as? ActionDraft.Filled ?: return offer.labelOf(kind)
	val row = offer.action(draft.kind) ?: return draft.kind
	val set = row.params.mapNotNull { param ->
		val value = draft.values[param.name].orEmpty()
		when (param.paramKind) {
			ActionParamKind.CHOICE -> param.options.find { it.value == value }?.label
			ActionParamKind.SWITCH -> offer.switches.find { it.device == value }?.name
			ActionParamKind.WORD -> value.takeIf { it.isNotBlank() }
			ActionParamKind.TEXT, ActionParamKind.FUNCTION, ActionParamKind.VALUES, null -> null
		}
	}
	return if (set.isEmpty()) row.label else "${row.label}: ${set.joinToString(", ")}"
}
