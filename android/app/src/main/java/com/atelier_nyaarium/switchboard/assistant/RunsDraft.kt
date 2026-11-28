package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleTokenKind
import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveCalled
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.util.UUID

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
	/** Its own steps. */
	data class Flat(val steps: List<StepDraft>) : RunsDraft

	data class Pointing(
		val functionId: String,
		/** The row's revision; 0 when new. */
		val base: Long,
		val name: String,
		val params: List<FunctionParamDraft>,
		val steps: List<StepDraft>,
		/** As typed, by parameter key. */
		val args: Map<String, String>,
		/** Carries what this build does not draw. */
		val held: AutomationAction.RunFunction,
		val mode: PointMode,
		/** The body as read; null when new. */
		val original: AutomationFunction?,
	) : RunsDraft

	/** A pointer whose function is not listed. */
	data class Unlisted(val action: AutomationAction) : RunsDraft
}

internal data class FunctionParamDraft(val key: String, val param: FunctionParam)

internal data class FunctionParamReference(val key: String, val name: String)

private fun paramDrafts(params: List<FunctionParam>): List<FunctionParamDraft> =
	params.map { FunctionParamDraft(UUID.randomUUID().toString(), it) }

internal fun RunsDraft.Pointing.wireParams(): List<FunctionParam> = params.map { it.param }

internal fun RunsDraft.Pointing.argsByName(): Map<String, String> = params.mapNotNull { row ->
	args[row.key]?.let { row.param.name to it }
}.toMap()

/** What an automation runs, less its cards. */
internal sealed interface RunsHead {
	/** Its own steps: flat, or an unnamed function. */
	data object Unnamed : RunsHead

	/** `pointing.steps` is unused; the cards are the steps. */
	data class Points(val pointing: RunsDraft.Pointing) : RunsHead

	data class Unlisted(val action: AutomationAction) : RunsHead
}

internal fun runsOf(head: RunsHead, cards: List<StepDraft>): RunsDraft = when (head) {
	RunsHead.Unnamed -> RunsDraft.Flat(cards)
	is RunsHead.Points -> head.pointing.copy(steps = cards)
	is RunsHead.Unlisted -> RunsDraft.Unlisted(head.action)
}

internal fun headOf(runs: RunsDraft): Pair<RunsHead, List<StepDraft>> = when (runs) {
	is RunsDraft.Flat -> RunsHead.Unnamed to runs.steps
	is RunsDraft.Pointing -> RunsHead.Points(runs.copy(steps = emptyList())) to runs.steps
	is RunsDraft.Unlisted -> RunsHead.Unlisted(runs.action) to emptyList()
}

/** An action step's card; what it cannot draw stays whole. */
internal fun stepDraftOf(step: FunctionStep, offer: AutomationOffer, params: List<FunctionParamDraft> = emptyList()): ActionDraft {
	val raw = wireJson.encodeToJsonElement(FunctionStep.serializer(), step).jsonObject
	// Labelled by its action; carried whole.
	val unsupported = ActionDraft.Unsupported(
		AutomationAction.Unknown(stepKindOf(step), JsonObject(mapOf(KIND_KEY to JsonPrimitive(stepKindOf(step)), STEP_KEY to raw))),
	)
	val action = step as? FunctionStep.Action ?: return unsupported
	if (action.`as` != null) return unsupported
	val row = offer.action(action.action)?.takeIf { it.drawable } ?: return unsupported
	val values = mutableMapOf<String, String>()
	val references = mutableMapOf<String, FunctionParamReference>()
	for ((name, raw) in action.args) {
		val arg = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), raw) }.getOrNull() ?: return unsupported
		when (arg) {
			is StepArg.Literal -> {
				val text = (arg.value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return unsupported
				if (row.param(name) == null) return unsupported
				values[name] = text
			}
			is StepArg.Expression -> {
				val named = lexConsole(arg.text).singleOrNull()?.takeIf { it.kind == ConsoleTokenKind.IDENT }?.text
				val param = params.firstOrNull { it.param.name == named } ?: return unsupported
				if (row.param(name)?.kind != PARAM_DEVICE || param.param.type != FunctionParamType.DEVICE.wire) return unsupported
				references[name] = FunctionParamReference(param.key, param.param.name)
			}
		}
	}
	return ActionDraft.Filled(row.kind, row.params.associate { it.name to values[it.name].orEmpty() }, references)
}

private const val KIND_KEY = "kind"

private const val STEP_KEY = "step"

/** Null when an action card cannot be a step. */
internal fun stepOf(draft: ActionDraft, offer: AutomationOffer, params: List<FunctionParamDraft> = emptyList()): FunctionStep? {
	val held = ((draft as? ActionDraft.Unsupported)?.action as? AutomationAction.Unknown)?.raw?.get(STEP_KEY)
	if (held != null) return runIsolated { wireJson.decodeFromJsonElement(FunctionStep.serializer(), held) }.getOrNull()
	val filled = draft as? ActionDraft.Filled ?: return null
	val byKey = params.associateBy { it.key }
	if (filled.references.values.any { reference -> byKey[reference.key]?.param?.type != FunctionParamType.DEVICE.wire }) return null
	val action = actionOf(filled.copy(references = emptyMap()), offer) ?: return null
	val row = offer.action(filled.kind) ?: return null
	val json = wireJson.encodeToJsonElement(AutomationAction.serializer(), action).jsonObject
	val kind = (json[KIND_KEY] as? JsonPrimitive)?.contentOrNull ?: return null
	val args = json.filterKeys { it != KIND_KEY }
	if (args.values.any { !(it is JsonPrimitive && it.isString) }) return null
	val encoded = args.mapValues { (_, value) -> wireJson.encodeToJsonElement(StepArg.serializer(), StepArg.Literal(value)) }.toMutableMap()
	for ((name, reference) in filled.references) {
		if (row.param(name)?.kind != PARAM_DEVICE) return null
		val param = byKey[reference.key] ?: return null
		encoded[name] = wireJson.encodeToJsonElement(StepArg.serializer(), StepArg.Expression(param.param.name))
	}
	return FunctionStep.Action(action = kind, args = JsonObject(encoded))
}

/** The runs a stored automation holds. */
internal fun runsDraftOf(automationId: String, automation: Automation, functions: List<AutomationFunctionRow>?, offer: AutomationOffer): RunsDraft {
	val pointer = written(automation).singleOrNull() as? AutomationAction.RunFunction
		?: return RunsDraft.Flat(written(automation).map { StepDraft.Action(freshKey(), actionDraftOf(it, offer)) })
	val row = functions?.firstOrNull { it.id == pointer.function } ?: return RunsDraft.Unlisted(pointer)
	val params = paramDrafts(row.function.params)
	val steps = written(row.function).map { treeOf(it, offer, params) }
	val args = params.mapNotNull { param ->
		pointer.args?.get(param.param.name)?.let { value -> param.key to (value as? JsonPrimitive)?.contentOrNull.orEmpty() }
	}.toMap()
	return RunsDraft.Pointing(
		functionId = row.id,
		base = row.revision,
		name = row.function.name,
		params = params,
		steps = steps,
		args = args,
		held = pointer,
		mode = PointMode.SHARED,
		original = row.function,
	)
}

/** Point at a listed function, carrying what the pointer held. */
internal fun pointedAt(runs: RunsDraft, automationId: String, row: AutomationFunctionRow, offer: AutomationOffer): RunsDraft.Pointing {
	val held = (runs as? RunsDraft.Pointing)?.held ?: AutomationAction.RunFunction(function = row.id)
	val params = paramDrafts(row.function.params)
	val steps = written(row.function).map { treeOf(it, offer, params) }
	return RunsDraft.Pointing(
		functionId = row.id,
		base = row.revision,
		name = row.function.name,
		params = params,
		steps = steps,
		args = emptyMap(),
		held = held.copy(function = row.id, args = null),
		mode = PointMode.SHARED,
		original = row.function,
	)
}

/** Typed text as the value the Gateway reads. */
internal fun functionArgOf(param: FunctionParam, text: String): JsonPrimitive? = when (param.type) {
	// Finite only.
	FunctionParamType.NUMBER.wire -> parseDecimal(text.trim())?.let { decimal -> JsonPrimitive(text.trim().toLongOrNull() ?: decimal) }
	else -> text.takeIf { it.isNotBlank() }?.let(::JsonPrimitive)
}

/** Else as typed. */
internal fun sentArgOf(param: FunctionParam, text: String): JsonPrimitive? =
	functionArgOf(param, text) ?: text.takeIf { it.isNotBlank() }?.let(::JsonPrimitive)

internal data class FunctionPreviewScope(val params: List<FunctionParam>, val args: JsonObject)

/** Callee parameters; arguments unset. */
internal fun calleePreviewScope(callee: CalleeDraft): FunctionPreviewScope =
	FunctionPreviewScope(callee.params.map { it.param }, JsonObject(emptyMap()))

internal fun functionPreviewScopeOf(runs: RunsDraft): FunctionPreviewScope? {
	val pointing = runs as? RunsDraft.Pointing ?: return null
	val args = pointing.params.mapNotNull { row ->
		pointing.args[row.key]?.let { functionArgOf(row.param, it) }?.let { row.param.name to it }
	}.toMap()
	return FunctionPreviewScope(pointing.wireParams(), JsonObject(args))
}

private fun bodyOf(
	name: String,
	params: List<FunctionParamDraft>,
	steps: List<StepDraft>,
	offer: AutomationOffer,
	calleeParams: CalleeParams,
): AutomationFunction? {
	val built = steps.map { stepOfDraft(it, offer, params, calleeParams) ?: return null }
	return AutomationFunction(name = name.trim(), params = params.map { it.param }, steps = built)
}

private fun calledOf(sending: List<CalleeDraft>, offer: AutomationOffer, calleeParams: CalleeParams): List<AutomationSaveCalled>? =
	sending.map { callee ->
		val body = bodyOf(callee.name, callee.params, callee.steps, offer, calleeParams) ?: return null
		AutomationSaveCalled(id = callee.id, body = body, base = callee.base)
	}

/** Plain actions under cap. */
internal fun flatActions(steps: List<StepDraft>, offer: AutomationOffer): List<AutomationAction>? {
	if (steps.isEmpty() || steps.size > MAX_ACTIONS) return null
	return steps.map { stepAction(it, offer) ?: return null }
}

internal fun unnamedServed(offer: AutomationOffer): Boolean = offer.functions?.served?.unnamed == true

/** Flat actions; unnamed fallback. */
internal fun saveOpOf(
	automationId: String,
	automationBase: Long,
	runs: RunsDraft,
	offer: AutomationOffer,
	confirmed: Boolean,
	ownFunctionId: String?,
	/** Edited and still reached. */
	sending: List<CalleeDraft>,
	calleeParams: CalleeParams,
	automationOf: (List<AutomationAction>) -> Automation?,
): ConsoleOp.AutomationSave? {
	fun op(
		actions: List<AutomationAction>,
		function: AutomationSaveFunction?,
		functionBase: Long? = null,
		called: List<AutomationSaveCalled> = emptyList(),
	): ConsoleOp.AutomationSave? {
		val automation = automationOf(actions) ?: return null
		return ConsoleOp.AutomationSave(
			automationId = automationId,
			automation = automation,
			automationBase = automationBase,
			function = function,
			called = called.takeIf { it.isNotEmpty() },
			functionBase = functionBase,
			confirmed = confirmed.takeIf { it },
		)
	}
	return when (runs) {
		is RunsDraft.Unlisted -> op(listOf(runs.action), null)
		is RunsDraft.Flat -> {
			flatActions(runs.steps, offer)?.let { return op(it, null) }
			val id = ownFunctionId?.takeIf { unnamedServed(offer) } ?: return null
			val body = bodyOf("", emptyList(), runs.steps, offer, calleeParams) ?: return null
			val called = calledOf(sending, offer, calleeParams) ?: return null
			op(listOf(AutomationAction.RunFunction(function = id)), AutomationSaveFunction.Edit(id = id, body = body, base = 0L), called = called)
		}
		is RunsDraft.Pointing -> {
			if (runs.name.isBlank()) {
				if (sharedName(runs, othersOf(runs, automationId, offer.functions))) return null
				// The revision it read guards the flatten.
				val read = runs.base.takeIf { runs.original != null }
				if (runs.params.isEmpty()) flatActions(runs.steps, offer)?.let { return op(it, null, read) }
				if (!unnamedServed(offer)) return null
			}
			val args = runs.params.mapNotNull { row -> runs.args[row.key]?.let { sentArgOf(row.param, it) }?.let { row.param.name to it } }
			val pointer = runs.held.copy(function = runs.functionId, args = JsonObject(args.toMap()).takeIf { args.isNotEmpty() })
			val body = bodyOf(runs.name, runs.params, runs.steps, offer, calleeParams) ?: return null
			val called = calledOf(sending, offer, calleeParams) ?: return null
			val function = when (runs.mode) {
				PointMode.SHARED -> if (body == runs.original) null else AutomationSaveFunction.Edit(id = runs.functionId, body = body, base = runs.base)
				PointMode.UNIQUE -> AutomationSaveFunction.Copy(from = runs.functionId, fromBase = runs.base, body = body)
				PointMode.NEW -> AutomationSaveFunction.Edit(id = runs.functionId, body = body, base = 0L)
			}
			op(listOf(pointer), function, runs.base.takeIf { function == null && runs.mode == PointMode.SHARED }, called)
		}
	}
}

internal fun AutomationDraft.withFunctionName(name: String, functions: FunctionOffer? = context.offer.functions): AutomationDraft = when (val head = runs) {
	RunsHead.Unnamed -> {
		if (name.isBlank()) this else {
			val id = newFunctionId ?: freshFunctionId()
			withRuns(RunsDraft.Pointing(id, 0L, name, emptyList(), steps, emptyMap(), AutomationAction.RunFunction(function = id), PointMode.NEW, null)).copy(newFunctionId = id)
		}
	}
	is RunsHead.Points -> {
		val pointing = head.pointing.copy(steps = steps)
		if (name.isNotBlank()) return copy(runs = RunsHead.Points(pointing.copy(name = name)))
		// Others hold the name; this one copies.
		val copies = sharedName(pointing, othersOf(pointing, id, functions)) && functions?.served?.unnamed == true
		copy(runs = RunsHead.Points(pointing.copy(name = "", mode = if (copies) PointMode.UNIQUE else pointing.mode)))
	}
	is RunsHead.Unlisted -> this
}

internal fun AutomationDraft.withFunctionParam(key: String, param: FunctionParam): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> {
		if (head.pointing.params.none { it.key == key }) return this
		copy(runs = RunsHead.Points(head.pointing.copy(params = head.pointing.params.map { row -> if (row.key == key) row.copy(param = param) else row })))
	}
	RunsHead.Unnamed, is RunsHead.Unlisted -> this
}

internal fun AutomationDraft.withoutFunctionParam(key: String): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> {
		val gone = head.pointing.params.firstOrNull { it.key == key } ?: return this
		copy(
			// Named as it left.
			steps = mapActions(steps) { action ->
				if (action !is ActionDraft.Filled) action
				else action.copy(references = action.references.mapValues { (_, held) -> if (held.key == key) held.copy(name = gone.param.name) else held })
			},
			runs = RunsHead.Points(head.pointing.copy(
				params = head.pointing.params.filterNot { it.key == key },
				args = head.pointing.args - key,
			)),
		)
	}
	RunsHead.Unnamed, is RunsHead.Unlisted -> this
}

internal fun AutomationDraft.plusFunctionParam(): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> copy(runs = RunsHead.Points(head.pointing.copy(params = head.pointing.params + FunctionParamDraft(UUID.randomUUID().toString(), FunctionParam(name = "", type = FunctionParamType.TEXT.wire)))))
	RunsHead.Unnamed, is RunsHead.Unlisted -> this
}

internal fun AutomationDraft.withFunctionArg(key: String, text: String): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> copy(runs = RunsHead.Points(head.pointing.copy(args = head.pointing.args + (key to text))))
	is RunsHead.Unnamed, is RunsHead.Unlisted -> this
}

/** First free suffix. */
internal fun uniqueFunctionName(name: String, listedNames: Collection<String>): String {
	val base = name.replace(Regex("\\.\\d{3}$"), "")
	val taken = listedNames.toSet()
	for (number in 1..999) {
		val suffix = ".${number.toString().padStart(3, '0')}"
		val candidate = base.take((Protocol.Wire.FUNCTION_NAME_MAX - suffix.length).coerceAtLeast(0)) + suffix
		if (candidate !in taken) return candidate
	}
	return name
}

/** Copies on Save. */
internal fun AutomationDraft.madeUnique(offer: AutomationOffer): AutomationDraft = when (val head = runs) {
	is RunsHead.Points -> {
		val listed = offer.functions?.rows.orEmpty().map { it.function.name }
		val base = head.pointing.name.ifBlank { head.pointing.original?.name.orEmpty() }
		val name = if (base.isBlank()) "" else uniqueFunctionName(base, listed)
		copy(runs = RunsHead.Points(head.pointing.copy(mode = PointMode.UNIQUE, name = name)))
	}
	is RunsHead.Unnamed, is RunsHead.Unlisted -> this
}

/** Only closes. */
internal fun AutomationDraft.pointedTo(row: AutomationFunctionRow, offer: AutomationOffer): AutomationDraft {
	val current = (runs as? RunsHead.Points)?.pointing?.functionId
	if (current == row.id) return copy(picking = false)
	// Its edited copy becomes the pointer's cards.
	val edited = callees[row.id]?.takeIf { it.edited() }
	val pointing = pointedAt(runsDraft(), id, row, offer).let { at ->
		edited?.let { at.copy(base = it.base, params = it.params, steps = it.steps, original = it.original) } ?: at
	}
	val swapped = swappedOwn(pointing, edited?.script, edited?.scripted == true)
	return swapped.copy(
		picking = false,
		callees = swapped.callees - row.id,
		inside = swapped.inside - row.id,
		text = swapped.text?.takeIf { swapped.treeHolding(it.key) != row.id },
		scriptPage = swapped.scriptPage?.takeIf { it.tree != row.id },
	)
}

/** A fresh empty body, a function once named. */
internal fun AutomationDraft.freshBody(): AutomationDraft =
	swappedOwn(RunsDraft.Flat(emptyList())).copy(picking = false, newFunctionId = null)

/** Other automations, then functions that run it. */
internal fun othersOf(runs: RunsDraft.Pointing, selfId: String, functions: FunctionOffer?): List<String> {
	val row = functions?.row(runs.functionId) ?: return emptyList()
	return row.users.filter { it != selfId } + row.callers.orEmpty()
}

/** Its name names a body others run. */
internal fun sharedName(runs: RunsDraft.Pointing, others: List<String>): Boolean = runs.mode == PointMode.SHARED && others.isNotEmpty()

internal fun AutomationDraft.reloadedFunction(row: AutomationFunctionRow, offer: AutomationOffer): Pair<AutomationDraft, Boolean> {
	val runs = runsDraft() as? RunsDraft.Pointing ?: return this to false
	if (runs.mode !in setOf(PointMode.SHARED, PointMode.UNIQUE) || runs.functionId != row.id) return this to false
	val dropped = runs.mode == PointMode.UNIQUE || script?.unread() == true ||
		bodyOf(runs.name, runs.params, runs.steps, offer, calleeParamsOf(this, offer)) != runs.original
	val oldArgs = runs.params.associate { it.param.name to (it.param.type to runs.args[it.key]) }
	val params = paramDrafts(row.function.params)
	val args = params.mapNotNull { param ->
		val (type, value) = oldArgs[param.param.name] ?: return@mapNotNull null
		value?.takeIf { type == param.param.type }?.let { param.key to it }
	}.toMap()
	val reloaded = runs.copy(
		base = row.revision,
		name = row.function.name,
		params = params,
		steps = written(row.function).map { treeOf(it, offer, params) },
		args = args,
		mode = PointMode.SHARED,
		original = row.function,
	)
	return swappedOwn(reloaded) to dropped
}

/** A card back as an automation's action; null for any card but a filled action. */
private fun stepAction(draft: StepDraft, offer: AutomationOffer): AutomationAction? = when (draft) {
	is StepDraft.Action -> when (val action = draft.action) {
		is ActionDraft.Filled -> actionOf(action, offer)
		is ActionDraft.Unsupported -> null
	}
	is StepDraft.If, is StepDraft.Try, is StepDraft.Switch, is StepDraft.Wait, is StepDraft.Return, is StepDraft.Comment,
	is StepDraft.RunFunction, is StepDraft.Variable, is StepDraft.Parallel, is StepDraft.Start, is StepDraft.Await,
	is StepDraft.Throw, is StepDraft.ScriptOnly -> null
}
