package com.atelier_nyaarium.switchboard

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.atelier_nyaarium.switchboard.plugins.PluginRegistry
import com.atelier_nyaarium.switchboard.plugins.ThreadForgetHandler

/** Every surface's forget, and what it asks first. */
internal class SessionForget(
	private val context: Context,
	private val repo: ChatRepository,
	private val handlers: PluginRegistry<ThreadForgetHandler>,
) {
	private val main = Handler(Looper.getMainLooper())

	/** Told once a forget has run. The shell leaves the conversation here. */
	var onForgotten: (String) -> Unit = {}

	fun ask(team: String): ForgetAsk = forgetAsk(repo.state.value, team)

	/** The whole forget. [cancelTasks] null: no board entries. */
	fun forget(team: String, cancelTasks: Boolean? = null) {
		repo.sessions.forget(team, cancelTasks?.let { if (it) "cancel" else "release" })
		handlers.forEachCaught(onError = ::logPluginThrow) { it.onForget(context, team) }
		SwitchboardService.cancelTeamNotification(context, team)
		SwitchboardService.cancelScheduledSendFailedNotification(context, team)
		onForgotten(team)
	}

	/** Holds the forget until [container] runs. A start that fails keeps the session. */
	fun startThenForget(team: String, container: String, cancelTasks: Boolean? = null) {
		repo.containers.startThen(container) { settle ->
			main.post {
				when (settle) {
					ContainerSettle.Running -> forget(team, cancelTasks)
					is ContainerSettle.Failed -> repo.holdStartFailure(team, settle.line)
				}
			}
		}
	}
}
