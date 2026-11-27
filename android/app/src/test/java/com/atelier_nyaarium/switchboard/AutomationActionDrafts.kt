package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ACTION_TELL
import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.ActionOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import com.atelier_nyaarium.switchboard.assistant.PARAM_CHOICE
import com.atelier_nyaarium.switchboard.assistant.ParamOffer
import com.atelier_nyaarium.switchboard.assistant.ParamOption
import com.atelier_nyaarium.switchboard.assistant.TRIGGER_EVENT
import com.atelier_nyaarium.switchboard.assistant.TriggerOffer
import com.atelier_nyaarium.switchboard.proto.AutomationTriggerName

internal fun toldDraft(told: String, message: String? = null): ActionDraft.Filled =
	ActionDraft.Filled("tell_assistant", listOfNotNull("when" to told, message?.let { "message" to it }).toMap())

internal fun plugDraft(device: String, verb: String): ActionDraft.Filled =
	ActionDraft.Filled("device_set", mapOf("device" to device, "verb" to verb))

internal fun iftttDraft(event: String, value1: String = "", value2: String = "", value3: String = ""): ActionDraft.Filled =
	ActionDraft.Filled("ifttt_trigger", mapOf("event" to event, "value1" to value1, "value2" to value2, "value3" to value3))

/** Empty-message event tell. */
internal fun tellOnlyOffer(away: Boolean = false): AutomationOffer = AutomationOffer(
	triggers = listOf(
		TriggerOffer(
			TRIGGER_EVENT,
			listOf(AutomationTriggerName("event", "The event; its fields by name"), AutomationTriggerName("source", "The source's name")),
		),
	),
	actions = listOf(
		ActionOffer(
			kind = ACTION_TELL,
			label = "Tell the assistant",
			danger = false,
			home = true,
			params = listOf(ParamOffer("when", "When", PARAM_CHOICE, options = listOf(ParamOption("now", "Now"), ParamOption("quietly", "Quietly")))),
		),
	),
	away = away,
)
