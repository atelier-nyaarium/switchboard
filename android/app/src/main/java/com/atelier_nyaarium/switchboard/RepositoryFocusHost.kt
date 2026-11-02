package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface RepositoryFocusHost {
	fun onForeground()
	fun onBackground()
	fun kickPoll()
	val visible: Boolean
}

internal class ChatRepositoryFocusHost(private val repo: ChatRepository) : RepositoryFocusHost {
	@Volatile private var visibleValue = false

	override val visible: Boolean get() = visibleValue

	override fun onForeground() {
		visibleValue = true
		repo.drain.onForegroundResume()
		repo._state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L, foreground = true) }
		repo.drain.kickPoll()
		if (repo.ownerOpsOrNull()?.domainId() != null) runIsolated { repo.socket.connect() }
		// A file can have moved while the phone was away, and only the owner's own typing is at stake.
		repo.repoScope.launch {
			repo.windowOps.recheckAll()
			repo.rawFileOps.recheckAll()
		}
	}

	override fun onBackground() {
		visibleValue = false
		repo.socket.onBackground()
		repo.pushback.onBackground(System.currentTimeMillis())
		repo._state.update { it.copy(foreground = false) }
	}

	override fun kickPoll() {
		repo.drain.kickPoll()
	}
}
