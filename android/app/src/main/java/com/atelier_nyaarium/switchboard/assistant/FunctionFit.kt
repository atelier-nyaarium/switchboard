package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.GivenType
import com.atelier_nyaarium.switchboard.proto.TriggerGives
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

internal data class Given(val name: String, val type: GivenType)

internal data class TriggerGiven(
	val names: List<Given>,
	/** Event triggers only. */
	val eventFields: List<String>? = null,
)

internal data class WrongValue(val name: String, val wants: String, val gets: GivenType)

internal data class FitAnswer(
	val fits: Boolean,
	/** Another source's event. */
	val hidden: Boolean,
	/** Names this trigger lacks. */
	val requires: List<String>,
	/** Still to set. */
	val unset: List<String>,
	val wrong: List<WrongValue>,
)

/** What a trigger of this kind gives by name. */
internal fun triggerGiven(kind: String, fieldType: GivenType? = null, eventFields: List<String>? = null): TriggerGiven {
	val names = TriggerGives.BY_TRIGGER[kind].orEmpty().mapNotNull { give ->
		val type = if (give.type == TriggerGives.OF_FIELD) fieldType ?: GivenType.TEXT else GivenType.entries.find { it.wire == give.type }
		type?.let { Given(give.name, it) }
	}
	return if (kind == TRIGGER_EVENT) TriggerGiven(names, (eventFields.orEmpty() + TriggerGives.EVENT_FIELDS).distinct()) else TriggerGiven(names)
}

private fun valueType(value: JsonPrimitive): GivenType =
	if (!value.isString && value.doubleOrNull != null) GivenType.NUMBER else GivenType.TEXT

/** A text may fill a device. */
private fun takes(wants: String, gets: GivenType): Boolean =
	wants == gets.wire || (wants == FunctionParamType.DEVICE.wire && gets == GivenType.TEXT)

/** Whether a trigger and these values fill the function. */
internal fun fitOf(
	given: TriggerGiven,
	params: List<FunctionParam>,
	reads: FunctionReads,
	values: Map<String, JsonPrimitive>,
): FitAnswer {
	val gives = given.names.associate { it.name to it.type }
	val declared = params.map { it.name }.toSet()
	val requires = reads.names.filter { it !in declared && it !in gives }
	val hidden = given.eventFields != null && reads.eventFields.any { it !in given.eventFields }
	val unset = mutableListOf<String>()
	val wrong = mutableListOf<WrongValue>()
	for (param in params) {
		val fromTrigger = gives[param.name]
		val gets = fromTrigger ?: values[param.name]?.let(::valueType)
		when {
			gets == null -> unset += param.name
			!(if (fromTrigger != null) fromTrigger.wire == param.type else takes(param.type, gets)) ->
				wrong += WrongValue(param.name, param.type, gets)
		}
	}
	return FitAnswer(
		fits = !hidden && requires.isEmpty() && unset.isEmpty() && wrong.isEmpty(),
		hidden = hidden,
		requires = requires,
		unset = unset,
		wrong = wrong,
	)
}
