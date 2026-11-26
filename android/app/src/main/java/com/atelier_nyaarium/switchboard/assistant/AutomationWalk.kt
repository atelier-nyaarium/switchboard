package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.OpensWalk
import com.atelier_nyaarium.switchboard.proto.Protocol

/** Exhaustive walk entry. */
internal sealed interface WalkEntry {
	val path: String
}

/** Automation action, not call. */
internal data class WalkAction(override val path: String, val index: Int, val action: AutomationAction) : WalkEntry

/** Called step, any depth. */
internal data class WalkStep(override val path: String, val index: Int, val step: FunctionStep, val via: String) : WalkEntry

internal enum class Unfollowed(val wire: String) {
	/** Walked without functions. */
	NOT_EXPANDED("not-expanded"),

	/** Function not held. */
	MISSING("missing"),

	/** Already above it. */
	LOOP("loop"),

	/** Past the walk's bound. */
	BUDGET("budget"),
}

internal data class UnfollowedCall(
	override val path: String,
	val call: AutomationAction.RunFunction,
	val reason: Unfollowed,
) : WalkEntry

private class Budget(var left: Int, var frames: Int)

@OptIn(OpensWalk::class)
private fun walk(automation: Automation, functionOf: ((String) -> AutomationFunction?)?): List<WalkEntry> {
	val budget = Budget(Protocol.Wire.WALK_ENTRIES_MAX, Protocol.Wire.RUN_FRAMES_MAX)
	return automation.actions.flatMapIndexed { at, action ->
		val path = at.toString()
		when {
			action !is AutomationAction.RunFunction -> listOf(WalkAction(path, at, action))
			functionOf == null -> listOf(UnfollowedCall(path, action, Unfollowed.NOT_EXPANDED))
			else -> followed(action, path, emptyList(), functionOf, budget)
		}
	}
}

/** Steps under call path. */
private fun followed(
	call: AutomationAction.RunFunction,
	site: String,
	chain: List<String>,
	functionOf: (String) -> AutomationFunction?,
	budget: Budget,
): List<WalkEntry> {
	if (call.function in chain) return listOf(UnfollowedCall(site, call, Unfollowed.LOOP))
	val function = functionOf(call.function) ?: return listOf(UnfollowedCall(site, call, Unfollowed.MISSING))
	val steps = stepsIn(written(function), emptyList())
	if (steps.size > budget.left || budget.frames == 0) return listOf(UnfollowedCall(site, call, Unfollowed.BUDGET))
	budget.left -= steps.size
	budget.frames -= 1
	val above = chain + call.function
	return steps.flatMap { (numbers, step) ->
		val path = (listOf(site) + numbers.map { it.toString() }).joinToString(".")
		val here = WalkStep(path, numbers.last(), step, call.function)
		if (step !is FunctionStep.Call) listOf(here)
		else listOf(here) + followed(AutomationAction.RunFunction(function = step.function), path, above, functionOf, budget)
	}
}

/** Parents precede children. */
private fun stepsIn(steps: List<FunctionStep>, base: List<Int>): List<Pair<List<Int>, FunctionStep>> =
	steps.withIndex().flatMap { (index, step) ->
		val at = base + index
		val sides = when (step) {
			is FunctionStep.If -> listOf(0 to step.steps.orEmpty(), 1 to step.`else`.orEmpty())
			is FunctionStep.Try -> listOf(0 to step.steps, 1 to step.catch)
			is FunctionStep.Do, is FunctionStep.Exit, is FunctionStep.Throw, is FunctionStep.Let,
			is FunctionStep.Wait, is FunctionStep.Note, is FunctionStep.Call, is FunctionStep.Unknown -> emptyList()
		}
		listOf(at to step) + sides.flatMap { (side, list) -> stepsIn(list, at + side) }
	}

/** Unexpanded calls, written order. */
internal fun reached(automation: Automation): List<WalkEntry> = walk(automation, null)

/** Follow available calls. */
internal fun reached(automation: Automation, functionOf: (String) -> AutomationFunction?): List<WalkEntry> =
	walk(automation, functionOf)

internal fun stepsOf(function: AutomationFunction): List<FunctionStep> = stepsIn(written(function), emptyList()).map { it.second }

/** A function's steps as written. */
@OptIn(OpensWalk::class)
internal fun written(function: AutomationFunction): List<FunctionStep> = function.steps

/** The functions a function's steps call, at any depth. */
internal fun callsOf(function: AutomationFunction): List<String> = called(written(function))

/** Kept steps' calls. */
internal fun callsIn(steps: List<FunctionStep>): List<String> = called(steps)

private fun called(steps: List<FunctionStep>): List<String> = steps.flatMap { step ->
	when (step) {
		is FunctionStep.Call -> listOf(step.function)
		is FunctionStep.If -> called(step.steps.orEmpty()) + called(step.`else`.orEmpty())
		is FunctionStep.Try -> called(step.steps) + called(step.catch)
		is FunctionStep.Do, is FunctionStep.Exit, is FunctionStep.Throw, is FunctionStep.Let,
		is FunctionStep.Wait, is FunctionStep.Note, is FunctionStep.Unknown -> emptyList()
	}
}

/** The list as written, one level; a call is never followed. */
@OptIn(OpensWalk::class)
internal fun written(automation: Automation): List<AutomationAction> = automation.actions
