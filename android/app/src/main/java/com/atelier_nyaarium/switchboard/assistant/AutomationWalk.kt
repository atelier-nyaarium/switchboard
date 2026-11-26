package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.OpensWalk

/** Exhaustive walk entry. */
internal sealed interface WalkEntry {
	val path: String
}

/** Automation action, not call. */
internal data class WalkAction(override val path: String, val index: Int, val action: AutomationAction) : WalkEntry

/** Called function step. */
internal data class WalkStep(override val path: String, val index: Int, val step: FunctionStep, val via: String) : WalkEntry

internal enum class Unfollowed(val wire: String) {
	/** Walked without functions. */
	NOT_EXPANDED("not-expanded"),

	/** Function not held. */
	MISSING("missing"),
}

internal data class UnfollowedCall(
	override val path: String,
	val call: AutomationAction.RunFunction,
	val reason: Unfollowed,
) : WalkEntry

@OptIn(OpensWalk::class)
private fun walk(automation: Automation, functionOf: ((String) -> AutomationFunction?)?): List<WalkEntry> =
	automation.actions.flatMapIndexed { at, action ->
		val path = at.toString()
		when {
			action !is AutomationAction.RunFunction -> listOf(WalkAction(path, at, action))
			functionOf == null -> listOf(UnfollowedCall(path, action, Unfollowed.NOT_EXPANDED))
			else -> functionOf(action.function)?.steps?.mapIndexed { inner, step ->
				WalkStep("$path.$inner", inner, step, action.function)
			} ?: listOf(UnfollowedCall(path, action, Unfollowed.MISSING))
		}
	}

/** Unexpanded calls, written order. */
internal fun reached(automation: Automation): List<WalkEntry> = walk(automation, null)

/** Follow available calls. */
internal fun reached(automation: Automation, functionOf: (String) -> AutomationFunction?): List<WalkEntry> =
	walk(automation, functionOf)

/** A function's steps as written. */
@OptIn(OpensWalk::class)
internal fun written(function: AutomationFunction): List<FunctionStep> = function.steps

/** The functions a function's steps call, at any depth. */
internal fun callsOf(function: AutomationFunction): List<String> = called(written(function))

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
