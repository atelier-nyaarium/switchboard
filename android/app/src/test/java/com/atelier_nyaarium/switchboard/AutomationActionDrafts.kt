package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft

internal fun toldDraft(told: String, message: String? = null): ActionDraft.Filled =
	ActionDraft.Filled("tell_assistant", listOfNotNull("when" to told, message?.let { "message" to it }).toMap())

internal fun plugDraft(device: String, verb: String): ActionDraft.Filled =
	ActionDraft.Filled("device_set", mapOf("device" to device, "verb" to verb))

internal fun iftttDraft(event: String, value1: String = "", value2: String = "", value3: String = ""): ActionDraft.Filled =
	ActionDraft.Filled("ifttt_trigger", mapOf("event" to event, "value1" to value1, "value2" to value2, "value3" to value3))
