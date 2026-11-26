package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.util.UUID

/** The sides a step holds; `number` is the side's place in a path. */
internal enum class Side(val number: Int) {
	THEN(0),
	ELSE(1),
	BODY(0),
	CATCH(1),
}

/** A step as the editor holds it, named by a key minted once. */
internal sealed interface StepDraft {
	val key: String

	data class Do(override val key: String, val action: ActionDraft) : StepDraft

	data class If(
		override val key: String,
		/** One expression, as typed. */
		val condition: String,
		val then: List<StepDraft>,
		val otherwise: List<StepDraft>,
	) : StepDraft

	data class Try(override val key: String, val body: List<StepDraft>, val catch: List<StepDraft>) : StepDraft

	/** Minutes as typed. */
	data class Wait(override val key: String, val minutes: String) : StepDraft

	data class Exit(override val key: String) : StepDraft

	data class Note(override val key: String, val text: String) : StepDraft

	/** Callee parameters key values. */
	data class Call(override val key: String, val function: String, val values: Map<String, CallValue>) : StepDraft

	/** What cards do not draw, written back as it was read. */
	data class Kept(override val key: String, val step: FunctionStep) : StepDraft
}

/** Null when unknown. */
internal typealias CalleeParams = (String) -> List<FunctionParam>?

/** Typed value; caller expression. */
internal sealed interface CallValue {
	data class Typed(val text: String) : CallValue

	data class Read(val expression: String) : CallValue
}

/** Where a new step lands: an index in the top list, or in a step's side. */
internal data class Slot(val parent: String?, val side: Side?, val index: Int)

internal val STEPS_PER_LIST = Protocol.Wire.FUNCTION_STEPS_MAX
internal val STEPS_TOTAL = Protocol.Wire.FUNCTION_STEPS_TOTAL_MAX
internal val STEPS_DEPTH = Protocol.Wire.FUNCTION_DEPTH_MAX

/** Its sides, in written order. */
internal fun sidesOf(step: StepDraft): List<Pair<Side, List<StepDraft>>> = when (step) {
	is StepDraft.If -> listOf(Side.THEN to step.then, Side.ELSE to step.otherwise)
	is StepDraft.Try -> listOf(Side.BODY to step.body, Side.CATCH to step.catch)
	is StepDraft.Do, is StepDraft.Wait, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Call, is StepDraft.Kept -> emptyList()
}

private fun withSide(step: StepDraft, side: Side, list: List<StepDraft>): StepDraft = when (step) {
	is StepDraft.If -> when (side) {
		Side.THEN -> step.copy(then = list)
		Side.ELSE -> step.copy(otherwise = list)
		Side.BODY, Side.CATCH -> step
	}
	is StepDraft.Try -> when (side) {
		Side.BODY -> step.copy(body = list)
		Side.CATCH -> step.copy(catch = list)
		Side.THEN, Side.ELSE -> step
	}
	is StepDraft.Do, is StepDraft.Wait, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Call, is StepDraft.Kept -> step
}

/** Every step at every depth, a step before what it holds. */
internal fun everyStep(steps: List<StepDraft>): List<StepDraft> =
	steps.flatMap { step -> listOf(step) + sidesOf(step).flatMap { (_, list) -> everyStep(list) } }

internal fun findStep(steps: List<StepDraft>, key: String): StepDraft? = everyStep(steps).firstOrNull { it.key == key }

/** One list deep is one. */
internal fun depthOf(steps: List<StepDraft>): Int =
	steps.maxOfOrNull { step -> 1 + (sidesOf(step).maxOfOrNull { (_, list) -> depthOf(list) } ?: 0) } ?: 0

private fun fits(steps: List<StepDraft>): Boolean {
	val lists = listOf(steps) + everyStep(steps).flatMap { step -> sidesOf(step).map { it.second } }
	return lists.all { it.size <= STEPS_PER_LIST } && everyStep(steps).size <= STEPS_TOTAL && depthOf(steps) <= STEPS_DEPTH
}

/** The step at `key` changed; every other key kept. */
internal fun replacedStep(steps: List<StepDraft>, key: String, change: (StepDraft) -> StepDraft): List<StepDraft> =
	steps.map { step ->
		if (step.key == key) change(step)
		else sidesOf(step).fold(step) { held, (side, list) -> withSide(held, side, replacedStep(list, key, change)) }
	}

internal fun removedStep(steps: List<StepDraft>, key: String): List<StepDraft> =
	steps.filter { it.key != key }.map { step ->
		sidesOf(step).fold(step) { held, (side, list) -> withSide(held, side, removedStep(list, key)) }
	}

private fun placed(steps: List<StepDraft>, slot: Slot, step: StepDraft): List<StepDraft> {
	fun into(list: List<StepDraft>) = list.toMutableList().apply { add(slot.index.coerceIn(0, size), step) }
	if (slot.parent == null) return into(steps)
	val side = slot.side ?: return steps
	return replacedStep(steps, slot.parent) { held ->
		val list = sidesOf(held).firstOrNull { it.first == side }?.second ?: return@replacedStep held
		withSide(held, side, into(list))
	}
}

/** Null where a cap refuses it, or the slot is gone. */
internal fun insertedStep(steps: List<StepDraft>, slot: Slot, step: StepDraft): List<StepDraft>? {
	if (slot.parent != null && findStep(steps, slot.parent) == null) return null
	return placed(steps, slot, step).takeIf { fits(it) && everyStep(it).size == everyStep(steps).size + everyStep(listOf(step)).size }
}

/** Null where it would land inside itself, or a cap refuses it. */
internal fun movedStep(steps: List<StepDraft>, key: String, slot: Slot): List<StepDraft>? {
	val step = findStep(steps, key) ?: return null
	if (slot.parent != null && findStep(listOf(step), slot.parent) != null) return null
	return insertedStep(removedStep(steps, key), slot, step)
}

/** Relative sibling slot. */
internal fun shiftedSlot(steps: List<StepDraft>, key: String, delta: Int): Slot? {
	val (parent, side, list) = listHolding(steps, key) ?: return null
	val index = list.indexOfFirst { it.key == key } + delta
	return Slot(parent, side, index).takeIf { index in list.indices }
}

private fun listHolding(steps: List<StepDraft>, key: String): Triple<String?, Side?, List<StepDraft>>? {
	if (steps.any { it.key == key }) return Triple(null, null, steps)
	for (step in everyStep(steps)) {
		for ((side, list) in sidesOf(step)) if (list.any { it.key == key }) return Triple(step.key, side, list)
	}
	return null
}

/** Each key's path under its function, as the Gateway spells it. */
internal fun pathsOf(steps: List<StepDraft>, base: String? = null): Map<String, String> =
	steps.withIndex().flatMap { (index, step) ->
		val path = if (base == null) "$index" else "$base.$index"
		listOf(step.key to path) + sidesOf(step).flatMap { (side, list) -> pathsOf(list, "$path.${side.number}").toList() }
	}.toMap()

/** Null when no step holds that path. */
internal fun keyAt(steps: List<StepDraft>, path: String): String? = pathsOf(steps).entries.firstOrNull { it.value == path }?.key

/** A stored body's paths, in written order. */
internal fun stepPaths(steps: List<FunctionStep>, base: String? = null): List<String> =
	steps.withIndex().flatMap { (index, step) ->
		val path = if (base == null) "$index" else "$base.$index"
		val sides = when (step) {
			is FunctionStep.If -> listOf(Side.THEN to step.steps.orEmpty(), Side.ELSE to step.`else`.orEmpty())
			is FunctionStep.Try -> listOf(Side.BODY to step.steps, Side.CATCH to step.catch)
			is FunctionStep.Parallel -> listOf(Side.BODY to step.steps)
			is FunctionStep.Start -> listOf(Side.BODY to step.steps)
			is FunctionStep.Do, is FunctionStep.Exit, is FunctionStep.Throw, is FunctionStep.Let, is FunctionStep.Await,
			is FunctionStep.Wait, is FunctionStep.Note, is FunctionStep.Call, is FunctionStep.Unknown -> emptyList()
		}
		listOf(path) + sides.flatMap { (side, list) -> stepPaths(list, "$path.${side.number}") }
	}

/** Written order: a step before what it holds. */
internal val byPath: Comparator<String> = Comparator { a, b ->
	val left = a.split(".").map { it.toInt() }
	val right = b.split(".").map { it.toInt() }
	left.zip(right).firstOrNull { (l, r) -> l != r }?.let { (l, r) -> l.compareTo(r) } ?: left.size.compareTo(right.size)
}

/** A fresh card's key. */
internal fun freshKey(): String = UUID.randomUUID().toString()

/** A stored step as cards; what a card cannot hold is kept whole. */
internal fun treeOf(
	step: FunctionStep,
	offer: AutomationOffer,
	params: List<FunctionValueDraft> = emptyList(),
	key: () -> String = ::freshKey,
): StepDraft = when (step) {
	is FunctionStep.Do -> StepDraft.Do(key(), stepDraftOf(step, offer, params))
	is FunctionStep.If -> StepDraft.If(
		key(),
		step.`when`,
		step.steps.orEmpty().map { treeOf(it, offer, params, key) },
		step.`else`.orEmpty().map { treeOf(it, offer, params, key) },
	)
	is FunctionStep.Try -> StepDraft.Try(
		key(),
		step.steps.map { treeOf(it, offer, params, key) },
		step.catch.map { treeOf(it, offer, params, key) },
	)
	is FunctionStep.Wait -> minutesText(step.minutes)?.let { StepDraft.Wait(key(), it) } ?: StepDraft.Kept(key(), step)
	is FunctionStep.Exit -> StepDraft.Exit(key())
	is FunctionStep.Note -> StepDraft.Note(key(), step.text)
	is FunctionStep.Call -> callValuesOf(step)?.let { StepDraft.Call(key(), step.function, it) } ?: StepDraft.Kept(key(), step)
	is FunctionStep.Throw, is FunctionStep.Let, is FunctionStep.Parallel, is FunctionStep.Start, is FunctionStep.Await,
	is FunctionStep.Unknown -> StepDraft.Kept(key(), step)
}

private fun callValuesOf(step: FunctionStep.Call): Map<String, CallValue>? =
	step.values.orEmpty().mapValues { (_, raw) ->
		when (val arg = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), raw) }.getOrNull()) {
			is StepArg.Expression -> CallValue.Read(arg.text)
			is StepArg.Literal -> (arg.value as? JsonPrimitive)?.takeIf { it.isString || it.doubleOrNull != null }?.let { CallValue.Typed(it.content) }
			null -> null
		} ?: return null
	}

/** Blank defers to trigger. */
private fun callStepOf(draft: StepDraft.Call, params: List<FunctionParam>?): FunctionStep? {
	val byName = params.orEmpty().associateBy { it.name }
	val values = draft.values.mapNotNull { (name, value) ->
		val arg = when (value) {
			is CallValue.Read -> value.expression.takeIf { it.isNotBlank() }?.let(StepArg::Expression)
			is CallValue.Typed -> {
				if (value.text.isBlank()) null
				else {
					val param = byName[name] ?: FunctionParam(name, FunctionParamType.TEXT.wire)
					StepArg.Literal(functionValueOf(param, value.text) ?: return null)
				}
			}
		}
		arg?.let { name to wireJson.encodeToJsonElement(StepArg.serializer(), it) }
	}.toMap()
	if (draft.function.isBlank()) return null
	return FunctionStep.Call(function = draft.function, values = JsonObject(values).takeIf { values.isNotEmpty() })
}

/** A literal number's text; null otherwise. */
private fun minutesText(arg: StepArg): String? {
	val literal = (arg as? StepArg.Literal)?.value as? JsonPrimitive ?: return null
	if (literal.isString) return null
	return literal.content.takeIf { literal.doubleOrNull != null }
}

/** Null when unwritable. */
internal fun stepOfDraft(
	draft: StepDraft,
	offer: AutomationOffer,
	params: List<FunctionValueDraft> = emptyList(),
	calleeParams: CalleeParams,
): FunctionStep? =
	when (draft) {
		is StepDraft.Do -> stepOf(draft.action, offer, params)
		is StepDraft.If -> {
			val then = draft.then.map { stepOfDraft(it, offer, params, calleeParams) ?: return null }
			val otherwise = draft.otherwise.map { stepOfDraft(it, offer, params, calleeParams) ?: return null }
			draft.condition.takeIf { it.isNotBlank() }?.let {
				FunctionStep.If(`when` = it, steps = then.takeIf { list -> list.isNotEmpty() }, `else` = otherwise.takeIf { list -> list.isNotEmpty() })
			}
		}
		is StepDraft.Try -> FunctionStep.Try(
			steps = draft.body.map { stepOfDraft(it, offer, params, calleeParams) ?: return null },
			catch = draft.catch.map { stepOfDraft(it, offer, params, calleeParams) ?: return null },
		)
		is StepDraft.Call -> callStepOf(draft, calleeParams(draft.function))
		is StepDraft.Wait -> minutesOf(draft.minutes)?.let { FunctionStep.Wait(StepArg.Literal(it)) }
		is StepDraft.Exit -> FunctionStep.Exit
		is StepDraft.Note -> FunctionStep.Note(draft.text)
		is StepDraft.Kept -> draft.step
	}

/** Whole minutes stay whole. */
private fun minutesOf(text: String): JsonPrimitive? {
	val trimmed = text.trim()
	val decimal = parseDecimal(trimmed) ?: return null
	return JsonPrimitive(trimmed.toLongOrNull() ?: decimal)
}

/** The same steps, keys aside. */
internal fun unkeyed(steps: List<StepDraft>): List<StepDraft> = steps.map { step ->
	when (step) {
		is StepDraft.Do -> step.copy(key = "")
		is StepDraft.If -> step.copy(key = "", then = unkeyed(step.then), otherwise = unkeyed(step.otherwise))
		is StepDraft.Try -> step.copy(key = "", body = unkeyed(step.body), catch = unkeyed(step.catch))
		is StepDraft.Wait -> step.copy(key = "")
		is StepDraft.Exit -> step.copy(key = "")
		is StepDraft.Note -> step.copy(key = "")
		is StepDraft.Call -> step.copy(key = "")
		is StepDraft.Kept -> step.copy(key = "")
	}
}

/** The action of every card that does one, at any depth. */
internal fun doings(steps: List<StepDraft>): List<StepDraft.Do> = everyStep(steps).filterIsInstance<StepDraft.Do>()

/** Each card's action changed; keys kept. */
internal fun mapDoings(steps: List<StepDraft>, change: (ActionDraft) -> ActionDraft): List<StepDraft> = steps.map { step ->
	when (step) {
		is StepDraft.Do -> step.copy(action = change(step.action))
		is StepDraft.If -> step.copy(then = mapDoings(step.then, change), otherwise = mapDoings(step.otherwise, change))
		is StepDraft.Try -> step.copy(body = mapDoings(step.body, change), catch = mapDoings(step.catch, change))
		is StepDraft.Wait, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Call, is StepDraft.Kept -> step
	}
}

/** A card's title. */
internal fun cardLabel(step: StepDraft, offer: AutomationOffer): String = when (step) {
	is StepDraft.Do -> offer.labelOf(step.action.kind)
	is StepDraft.If -> "If"
	is StepDraft.Try -> "Try"
	is StepDraft.Wait -> "Wait"
	is StepDraft.Exit -> "Stop here"
	is StepDraft.Note -> "Note"
	is StepDraft.Call -> "Call"
	is StepDraft.Kept -> when (val held = step.step) {
		is FunctionStep.Throw -> "Fail"
		is FunctionStep.Let -> "Keep a value"
		is FunctionStep.Call -> "Run a function"
		is FunctionStep.Wait -> "Wait"
		is FunctionStep.Parallel -> "Together"
		is FunctionStep.Start -> "Start a task"
		is FunctionStep.Await -> "Wait for a task"
		is FunctionStep.Unknown -> held.kind
		is FunctionStep.Do, is FunctionStep.If, is FunctionStep.Try, is FunctionStep.Exit, is FunctionStep.Note -> "Step"
	}
}
