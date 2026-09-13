package com.atelier_nyaarium.switchboard.workspace

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** What a tap outside Files asks it to show. */
internal sealed interface WorkspaceOpen {
	data class File(val path: String) : WorkspaceOpen

	data class Window(val symbolId: String) : WorkspaceOpen
}

/** One request to show a session's workspace, raised by a tap somewhere else in the app. */
internal data class WorkspaceOpenRequest(val team: String, val open: WorkspaceOpen)

/**
 * Held until the Files view it names composes.
 *
 * The latest wins. That view clears it, or the shell once its session is gone.
 */
internal object WorkspaceOpenBus {
	private val _pending = MutableStateFlow<WorkspaceOpenRequest?>(null)
	val pending: StateFlow<WorkspaceOpenRequest?> = _pending

	fun request(request: WorkspaceOpenRequest) {
		_pending.value = request
	}

	/** Compared, so a newer request raised while this one was being shown is not dropped with it. */
	fun shown(request: WorkspaceOpenRequest) {
		_pending.compareAndSet(request, null)
	}
}
