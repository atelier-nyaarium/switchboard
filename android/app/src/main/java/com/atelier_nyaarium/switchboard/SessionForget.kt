package com.atelier_nyaarium.switchboard

import android.content.Context
import com.atelier_nyaarium.switchboard.plugins.PluginRegistry
import com.atelier_nyaarium.switchboard.plugins.ThreadForgetHandler

/** Every surface's forget. */
internal class SessionForget(
	private val context: Context,
	private val sessions: SessionOps,
	private val handlers: PluginRegistry<ThreadForgetHandler>,
) {
	/** [cancelTasks] null: no board entries. */
	fun forget(team: String, cancelTasks: Boolean? = null) {
		sessions.forget(team, cancelTasks?.let { if (it) "cancel" else "release" })
		handlers.forEachCaught(onError = ::logPluginThrow) { it.onForget(context, team) }
		SwitchboardService.cancelTeamNotification(context, team)
		SwitchboardService.cancelScheduledSendFailedNotification(context, team)
	}
}
