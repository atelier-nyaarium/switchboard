package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/** How a pointer's function is written on save. */
internal enum class PointMode {
	/** The listed function, edited in place. */
	SHARED,

	/** A Gateway-named copy. */
	UNIQUE,

	/** Phone-minted, base 0. */
	NEW,
}

/** What an automation runs, as the editor holds it. */
internal sealed interface RunsDraft {
	/** Its own steps; a typed name makes them a function. */
	data class Flat(val actions: List<ActionDraft>, val name: String = "") : RunsDraft

	data class Pointing(
		val functionId: String,
		/** The row's revision; 0 when new. */
		val base: Long,
		val name: String,
		val params: List<FunctionParam>,
		val steps: List<ActionDraft>,
		/** As typed, by param name. */
		val values: Map<String, String>,
		/** Carries what this build does not draw. */
		val held: AutomationAction.RunFunction,
		val mode: PointMode,
		/** The body as read; null when new. */
		val original: AutomationFunction?,
		/** Other automations running it. */
		val others: List<String>,
	) : RunsDraft

	/** A pointer whose function is not listed. */
	data class Kept(val action: AutomationAction) : RunsDraft
}

/** What an automation runs, less its cards. */
internal sealed interface RunsHead {
	/** Its own steps; a typed name makes them a function. */
	data class Own(val name: String = "") : RunsHead

	/** `pointing.steps` is unused; the cards are the steps. */
	data class Points(val pointing: RunsDraft.Pointing) : RunsHead

	data class Kept(val action: AutomationAction) : RunsHead
}

internal fun runsOf(head: RunsHead, cards: List<ActionDraft>): RunsDraft = when (head) {
	is RunsHead.Own -> RunsDraft.Flat(cards, head.name)
	is RunsHead.Points -> head.pointing.copy(steps = cards)
	is RunsHead.Kept -> RunsDraft.Kept(head.action)
}

internal fun headOf(runs: RunsDraft): Pair<RunsHead, List<ActionDraft>> = when (runs) {
	is RunsDraft.Flat -> RunsHead.Own(runs.name) to runs.actions
	is RunsDraft.Pointing -> RunsHead.Points(runs.copy(steps = emptyList())) to runs.steps
	is RunsDraft.Kept -> RunsHead.Kept(runs.action) to emptyList()
}

/** Drawn only when every arg is literal text. */
internal fun stepDraftOf(step: FunctionStep, offer: AutomationOffer): ActionDraft {
	val raw = wireJson.encodeToJsonElement(FunctionStep.serializer(), step).jsonObject
	// Labelled by its action; carried whole.
	val kept = ActionDraft.Kept(
		AutomationAction.Unknown(stepKind(step), JsonObject(mapOf(KIND_KEY to JsonPrimitive(stepKind(step)), STEP_KEY to raw))),
	)
	val doing = step as? FunctionStep.Do ?: return kept
	val texts = doing.args.mapValues { (_, arg) ->
		val literal = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), arg) }.getOrNull() as? StepArg.Literal
		(literal?.value as? JsonPrimitive)?.takeIf { it.isString }?.content
	}
	if (texts.values.any { it == null }) return kept
	val action = buildJsonObject {
		put(KIND_KEY, JsonPrimitive(doing.action))
		for ((key, value) in texts) put(key, JsonPrimitive(value))
	}
	val asAction = runIsolated { wireJson.decodeFromJsonElement(AutomationAction.serializer(), action) }.getOrNull() ?: return kept
	return when (val drawn = actionDraftOf(asAction, offer)) {
		is ActionDraft.Filled -> drawn
		is ActionDraft.Kept -> kept
	}
}

private const val KIND_KEY = "kind"

private const val STEP_KEY = "step"

private fun stepKind(step: FunctionStep): String = when (step) {
	is FunctionStep.Do -> step.action
	is FunctionStep.Unknown -> step.kind
}

/** Null when a card cannot be a step. */
internal fun stepOf(draft: ActionDraft, offer: AutomationOffer): FunctionStep? {
	val held = ((draft as? ActionDraft.Kept)?.action as? AutomationAction.Unknown)?.raw?.get(STEP_KEY)
	if (held != null) return runIsolated { wireJson.decodeFromJsonElement(FunctionStep.serializer(), held) }.getOrNull()
	val action = actionOf(draft, offer) ?: return null
	val json = wireJson.encodeToJsonElement(AutomationAction.serializer(), action).jsonObject
	val kind = (json[KIND_KEY] as? JsonPrimitive)?.contentOrNull ?: return null
	val args = json.filterKeys { it != KIND_KEY }
	if (args.values.any { !(it is JsonPrimitive && it.isString) }) return null
	return FunctionStep.Do(action = kind, args = JsonObject(args.mapValues { (_, v) -> wireJson.encodeToJsonElement(StepArg.serializer(), StepArg.Literal(v)) }))
}

/** The runs a stored automation holds. */
internal fun runsDraftOf(automationId: String, automation: Automation, functions: List<AutomationFunctionRow>?, offer: AutomationOffer): RunsDraft {
	val pointer = written(automation).singleOrNull() as? AutomationAction.RunFunction
		?: return RunsDraft.Flat(written(automation).map { actionDraftOf(it, offer) })
	val row = functions?.firstOrNull { it.id == pointer.function } ?: return RunsDraft.Kept(pointer)
	return RunsDraft.Pointing(
		functionId = row.id,
		base = row.revision,
		name = row.function.name,
		params = row.function.params,
		steps = written(row.function).map { stepDraftOf(it, offer) },
		values = pointer.values.orEmpty().mapValues { (_, v) -> (v as? JsonPrimitive)?.contentOrNull.orEmpty() },
		held = pointer,
		mode = PointMode.SHARED,
		original = row.function,
		others = row.users.filter { it != automationId },
	)
}

/** Point at a listed function, keeping what the pointer carried. */
internal fun pointedAt(runs: RunsDraft, automationId: String, row: AutomationFunctionRow, offer: AutomationOffer): RunsDraft.Pointing {
	val held = (runs as? RunsDraft.Pointing)?.held ?: AutomationAction.RunFunction(function = row.id)
	return RunsDraft.Pointing(
		functionId = row.id,
		base = row.revision,
		name = row.function.name,
		params = row.function.params,
		steps = written(row.function).map { stepDraftOf(it, offer) },
		values = emptyMap(),
		held = held.copy(function = row.id, values = null),
		mode = PointMode.SHARED,
		original = row.function,
		others = row.users.filter { it != automationId },
	)
}

/** Typed text as the value the Gateway reads. */
internal fun functionValueOf(param: FunctionParam, text: String): JsonPrimitive? = when (param.type) {
	FunctionParamType.NUMBER.wire -> JsonPrimitive(text.trim()).let { it.longOrNull?.let(::JsonPrimitive) ?: it.doubleOrNull?.let(::JsonPrimitive) }
	else -> text.takeIf { it.isNotBlank() }?.let(::JsonPrimitive)
}

private fun bodyOf(name: String, params: List<FunctionParam>, steps: List<ActionDraft>, offer: AutomationOffer): AutomationFunction? {
	val built = steps.map { stepOf(it, offer) ?: return null }
	return AutomationFunction(name = name.trim(), params = params, steps = built)
}

/** The save op; null when the draft cannot be written. */
internal fun saveOpOf(
	automationId: String,
	automationBase: Long,
	runs: RunsDraft,
	offer: AutomationOffer,
	confirmed: Boolean,
	freshFunctionId: () -> String,
	automationOf: (List<AutomationAction>) -> Automation?,
): ConsoleOp.AutomationSave? {
	fun op(actions: List<AutomationAction>, function: AutomationSaveFunction?): ConsoleOp.AutomationSave? {
		val automation = automationOf(actions) ?: return null
		return ConsoleOp.AutomationSave(
			automationId = automationId,
			automation = automation,
			automationBase = automationBase,
			function = function,
			confirmed = confirmed.takeIf { it },
		)
	}
	return when (runs) {
		is RunsDraft.Kept -> op(listOf(runs.action), null)
		is RunsDraft.Flat -> if (runs.name.isBlank()) {
			op(runs.actions.map { actionOf(it, offer) ?: return null }, null)
		} else {
			val id = freshFunctionId()
			val body = bodyOf(runs.name, emptyList(), runs.actions, offer) ?: return null
			op(listOf(AutomationAction.RunFunction(function = id)), AutomationSaveFunction.Edit(id = id, body = body, base = 0L))
		}
		is RunsDraft.Pointing -> {
			if (runs.name.isBlank()) {
				// Its own steps again.
				if (sharedName(runs)) return null
				return op(runs.steps.map { stepAction(it, offer) ?: return null }, null)
			}
			val values = runs.params.mapNotNull { param -> runs.values[param.name]?.let { functionValueOf(param, it) }?.let { param.name to it } }
			val pointer = runs.held.copy(function = runs.functionId, values = JsonObject(values.toMap()).takeIf { values.isNotEmpty() })
			val body = bodyOf(runs.name, runs.params, runs.steps, offer) ?: return null
			val function = when (runs.mode) {
				PointMode.SHARED -> if (body == runs.original) null else AutomationSaveFunction.Edit(id = runs.functionId, body = body, base = runs.base)
				PointMode.UNIQUE -> AutomationSaveFunction.Copy(from = runs.functionId, fromBase = runs.base, body = body)
				PointMode.NEW -> AutomationSaveFunction.Edit(id = runs.functionId, body = body, base = 0L)
			}
			op(listOf(pointer), function)
		}
	}
}

/** Types into the name field; Own and Points alike. */
internal fun AutomationDraft.withFunctionName(name: String): AutomationDraft = when (val head = runs) {
	is RunsHead.Own -> copy(runs = RunsHead.Own(name))
	is RunsHead.Points -> copy(runs = RunsHead.Points(head.pointing.copy(name = name)))
	is RunsHead.Kept -> this
}

internal fun AutomationDraft.withFunctionValue(param: String, text: String): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> copy(runs = RunsHead.Points(head.pointing.copy(values = head.pointing.values + (param to text))))
	is RunsHead.Own, is RunsHead.Kept -> this
}

/** Copies on Save. */
internal fun AutomationDraft.madeUnique(): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> copy(runs = RunsHead.Points(head.pointing.copy(mode = PointMode.UNIQUE)))
	is RunsHead.Own, is RunsHead.Kept -> this
}

/** Points at a listed function; the one left loses a use. */
internal fun AutomationDraft.pointedTo(row: AutomationFunctionRow, offer: AutomationOffer): AutomationDraft =
	withRuns(pointedAt(runsDraft(), id, row, offer)).copy(picking = false)

/** A fresh empty body, a function once named. */
internal fun AutomationDraft.freshBody(): AutomationDraft = withRuns(RunsDraft.Flat(emptyList())).copy(picking = false)

/** Its name names a body others run. */
internal fun sharedName(runs: RunsDraft.Pointing): Boolean = runs.mode == PointMode.SHARED && runs.others.isNotEmpty()

/** A step back as an automation's action. */
private fun stepAction(draft: ActionDraft, offer: AutomationOffer): AutomationAction? = when (draft) {
	is ActionDraft.Filled -> actionOf(draft, offer)
	is ActionDraft.Kept -> null
}
