package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.OpensWalk

/** One action an automation reaches. */
internal data class Reached(val path: String, val action: AutomationAction)

/** Every action an automation reaches, in written order. */
@OptIn(OpensWalk::class)
internal fun reached(automation: Automation): List<Reached> =
	automation.actions.mapIndexed { at, action -> Reached(at.toString(), action) }

/** The list as written, one level; a call is never followed. */
@OptIn(OpensWalk::class)
internal fun written(automation: Automation): List<AutomationAction> = automation.actions
