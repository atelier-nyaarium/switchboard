package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction

/** One action an automation reaches. */
internal data class Reached(val path: String, val action: AutomationAction)

/** Every action an automation reaches, in written order. */
internal fun reached(automation: Automation): List<Reached> =
	automation.actions.mapIndexed { at, action -> Reached(at.toString(), action) }
