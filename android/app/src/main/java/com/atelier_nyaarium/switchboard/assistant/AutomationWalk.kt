package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.OpensWalk

/** One row the walk answers. */
internal sealed interface Reach {
	val path: String

	/** The action it does. */
	val kind: String
}

/** Written on the automation itself. */
internal data class Reached(override val path: String, val action: AutomationAction) : Reach {
	override val kind: String get() = kindOf(action)
}

/** A function's step, through the automation's pointer. */
internal data class ReachedStep(override val path: String, val step: FunctionStep, val via: String) : Reach {
	override val kind: String get() = when (step) {
		is FunctionStep.Do -> step.action
		is FunctionStep.Unknown -> step.kind
	}
}

/** Every action an automation reaches, in written order. */
@OptIn(OpensWalk::class)
internal fun reached(automation: Automation): List<Reached> =
	automation.actions.mapIndexed { at, action -> Reached(at.toString(), action) }

/** Follows each call; a pointer it cannot follow is reached itself. */
@OptIn(OpensWalk::class)
internal fun reached(automation: Automation, functionOf: (String) -> AutomationFunction?): List<Reach> =
	automation.actions.flatMapIndexed { at, action ->
		val path = at.toString()
		val fn = (action as? AutomationAction.RunFunction)?.let { functionOf(it.function) }
		if (fn == null || action !is AutomationAction.RunFunction) {
			listOf(Reached(path, action))
		} else {
			fn.steps.mapIndexed { inner, step -> ReachedStep("$path.$inner", step, action.function) }
		}
	}

/** The list as written, one level; a call is never followed. */
@OptIn(OpensWalk::class)
internal fun written(automation: Automation): List<AutomationAction> = automation.actions
