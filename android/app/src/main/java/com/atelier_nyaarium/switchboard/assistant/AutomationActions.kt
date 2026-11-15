package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationActionOffer
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

internal const val ACTION_TELL = "tell_assistant"
internal const val MAX_ACTIONS = 8

internal const val PARAM_TEXT = "text"
internal const val PARAM_WORD = "word"
internal const val PARAM_SWITCH = "switch"
internal const val PARAM_CHOICE = "choice"
private val PARAM_KINDS = setOf(PARAM_TEXT, PARAM_WORD, PARAM_SWITCH, PARAM_CHOICE)
private val WORD = Regex("^[A-Za-z0-9_-]+$")
private const val KIND = "kind"

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

internal data class ActionOffer(
	val kind: String,
	val label: String,
	val danger: Boolean,
	/** Does nothing away from the assistant's home. */
	val home: Boolean = false,
	val params: List<ParamOffer> = emptyList(),
) {
	/** False once a parameter is of a kind this build cannot draw. */
	val drawable: Boolean get() = params.all { it.kind in PARAM_KINDS }

	fun param(name: String): ParamOffer? = params.find { it.name == name }
}

// Remove 2026-11-29: a Gateway that names no kinds.
/** A tell with no message. */
internal val DEFAULT_TELL = ActionOffer(
	kind = ACTION_TELL,
	label = "Tell the assistant",
	danger = false,
	home = true,
	params = listOf(ParamOffer("when", "When", PARAM_CHOICE, options = listOf(ParamOption("now", "Now"), ParamOption("quietly", "Quietly")))),
)

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

	data class Filled(override val kind: String, val values: Map<String, String>) : ActionDraft

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

private fun issueOf(action: ActionDraft, offer: AutomationOffer, blanks: Boolean): String? = when (action) {
	is ActionDraft.Kept -> null
	is ActionDraft.Filled -> {
		val row = offer.action(action.kind)
		if (row == null) "This Gateway no longer offers it"
		else row.params.firstNotNullOfOrNull { param ->
			val value = action.values[param.name].orEmpty()
			if (!blanks && value.isBlank()) null else paramIssue(param, value, offer)
		}
	}
}

internal fun actionIssue(action: ActionDraft, offer: AutomationOffer): String? = issueOf(action, offer, blanks = true)

/** Silent about a parameter that is still blank. */
internal fun actionHint(action: ActionDraft, offer: AutomationOffer): String? = issueOf(action, offer, blanks = false)

/** A blank optional parameter is left out; null when the action does not read back. */
internal fun actionOf(action: ActionDraft, offer: AutomationOffer): AutomationAction? = when (action) {
	is ActionDraft.Kept -> action.action
	is ActionDraft.Filled -> offer.action(action.kind)?.let { row ->
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
		param.name to when (param.kind) {
			PARAM_CHOICE -> param.options.firstOrNull()?.value.orEmpty()
			PARAM_SWITCH -> offer.switches.firstOrNull()?.device ?: return null
			else -> ""
		}
	}
	return ActionDraft.Filled(kind, values)
}

internal fun addableActions(offer: AutomationOffer, held: List<ActionDraft>): List<ActionOffer> =
	if (held.size >= MAX_ACTIONS) emptyList() else offer.actions.filter { freshAction(it.kind, offer) != null }

internal fun withValue(action: ActionDraft, param: String, value: String): ActionDraft = when (action) {
	is ActionDraft.Filled -> action.copy(values = action.values + (param to value))
	is ActionDraft.Kept -> action
}

/** Its label, then what its choices, switch and words are set to. */
internal fun actionLine(action: AutomationAction, offer: AutomationOffer = AutomationOffer()): String {
	val draft = actionDraftOf(action, offer) as? ActionDraft.Filled ?: return offer.labelOf(kindOf(action))
	val row = offer.action(draft.kind) ?: return draft.kind
	val set = row.params.mapNotNull { param ->
		val value = draft.values[param.name].orEmpty()
		when (param.kind) {
			PARAM_CHOICE -> param.options.find { it.value == value }?.label
			PARAM_SWITCH -> offer.switches.find { it.device == value }?.name
			PARAM_WORD -> value.takeIf { it.isNotBlank() }
			else -> null
		}
	}
	return if (set.isEmpty()) row.label else "${row.label}: ${set.joinToString(", ")}"
}
