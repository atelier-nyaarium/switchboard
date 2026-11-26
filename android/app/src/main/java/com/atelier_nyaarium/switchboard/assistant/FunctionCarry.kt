package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarried
import com.atelier_nyaarium.switchboard.proto.CarriedAutomation
import com.atelier_nyaarium.switchboard.proto.CarriedFunction
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.FunctionStep

/** Called function id. */
private fun calledBy(entry: WalkEntry): String? = when (entry) {
	is UnfollowedCall -> entry.call.function
	is WalkAction, is WalkStep -> null
}

/** Each function a carried automation runs, once, in listing order; one not listed stays behind. */
internal fun carriedFunctionsOf(automations: List<CarriedAutomation>, listed: List<CarriedFunction>): List<CarriedFunction> {
	val runs = automations.flatMap { carried -> reached(carried.automation).mapNotNull(::calledBy) }.toSet()
	return listed.filter { it.id in runs }
}

/** Why a move cannot carry these functions yet, or at all. */
internal sealed interface CarryRefusal {
	data object NoFunctions : CarryRefusal

	/** Null when unknown. */
	data class StepNotServed(val kind: String, val label: String? = null) : CarryRefusal

	/** Its list has not arrived. */
	data object Reading : CarryRefusal

	data object Unreachable : CarryRefusal

	/** Past the Router's sealed bound. */
	data object TooLarge : CarryRefusal
}

/** The ciphertext's bytes, from its base64 length. */
private fun decodedBytes(base64: String): Long {
	val padding = base64.takeLastWhile { it == '=' }.length
	return base64.length.toLong() * 3 / 4 - padding
}

/** Refused before the Router would refuse it. */
internal fun sealedRefusal(envelope: ContentEnvelope): CarryRefusal? =
	CarryRefusal.TooLarge.takeIf { decodedBytes(envelope.ciphertext) > Protocol.Wire.ASSISTANT_HOME_SEALED_MAX_BYTES }

/** Functions, or a pointer. */
internal fun carriesFunctions(carried: AssistantHomeCarried?): Boolean =
	!carried?.functions.isNullOrEmpty() ||
		carried?.automations.orEmpty().any { held -> reached(held.automation).any { calledBy(it) != null } }

/** Null when the destination holds every carried step kind. */
internal fun carryRefusal(
	carried: AssistantHomeCarried?,
	served: FunctionsServed,
	/** Kind's label, when known. */
	labelOf: (String) -> String? = { null },
): CarryRefusal? {
	if (!carriesFunctions(carried)) return null
	val functions = carried?.functions.orEmpty()
	val held = when (served) {
		is FunctionsServed.Serves -> served.served
		FunctionsServed.None -> return CarryRefusal.NoFunctions
		FunctionsServed.Reading -> return CarryRefusal.Reading
		FunctionsServed.Unreachable -> return CarryRefusal.Unreachable
	}
	val kinds = functions.flatMap { written(it.function) }.map { step ->
		when (step) {
			is FunctionStep.Do -> step.action
			is FunctionStep.Unknown -> step.kind
		}
	}
	return kinds.firstOrNull { it !in held.steps }?.let { CarryRefusal.StepNotServed(it, labelOf(it)) }
}
