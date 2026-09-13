package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface RepositoryFocusHost {
	fun onForeground()
	fun onBackground()
	fun declareFocus(focus: FocusIntent)
	fun kickPoll()
	val visible: Boolean
	var currentFocus: FocusIntent
	var lastVisibleFocus: FocusIntent
}

internal class ChatRepositoryFocusHost(private val repo: ChatRepository) : RepositoryFocusHost {
	@Volatile private var visibleValue = false
	@Volatile override var currentFocus: FocusIntent = FocusIntent(screen = "background")
	@Volatile override var lastVisibleFocus: FocusIntent = FocusIntent(screen = "board")

	override val visible: Boolean get() = visibleValue

	override fun onForeground() {
		visibleValue = true
		repo.drain.onForegroundResume()
		repo._state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L, foreground = true) }
		declareFocus(lastVisibleFocus)
		repo.drain.kickPoll()
		if (repo.ownerOpsOrNull()?.domainId() != null) runCatching { repo.socket.connect() }
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
		declareFocus(FocusIntent(screen = "background"))
		repo._state.update { it.copy(foreground = false) }
	}

	override fun kickPoll() {
		repo.drain.kickPoll()
	}

	override fun declareFocus(focus: FocusIntent) {
		val prior = currentFocus
		currentFocus = focus
		if (focus.screen != "background") lastVisibleFocus = focus
		if (prior != focus) repo.drain.kickPoll()
	}
}
