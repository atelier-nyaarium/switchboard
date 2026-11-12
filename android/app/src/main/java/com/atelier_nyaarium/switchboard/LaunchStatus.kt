package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

////////////////////////////////
//  Interfaces & Types

/** A launch that failed, held until dismissed or the session is up. */
data class LaunchError(val line: String, val at: Long)

/** This session's launch as the thread docks it. */
data class LaunchState(
	val error: String?,
	val onDismissError: () -> Unit,
)

////////////////////////////////
//  Constants

private const val NOTICE_ROW = "notice"
private const val FAILED_ROW = "failed"

////////////////////////////////
//  Functions & Helpers

/** A failed launch's row is docked, never threaded. */
internal fun launchErrorOf(entry: MailboxEntry): LaunchError? {
	if (entry.kind != NOTICE_ROW || entry.launch != FAILED_ROW) return null
	val line = entry.body?.trim().orEmpty()
	return if (line.isEmpty()) null else LaunchError(line, entry.at)
}

/** A session that is up has no failed launch. */
internal fun launchErrorsAfter(held: Map<String, LaunchError>, fresh: List<Team>): Map<String, LaunchError> {
	if (held.isEmpty()) return held
	val up = fresh.filter { it.presence.isOnline }.mapTo(HashSet()) { it.name }
	return if (held.keys.none { it in up }) held else held - up
}

/** False for a session that is already up: its row says nothing. */
internal fun MutableStateFlow<ChatState>.holdLaunchError(team: String, error: LaunchError): Boolean {
	var held = false
	update { state ->
		held = state.teams.none { it.name == team && it.presence.isOnline }
		if (held) state.copy(launchErrors = state.launchErrors + (team to error)) else state
	}
	return held
}

internal fun MutableStateFlow<ChatState>.dismissLaunchError(team: String) {
	update { if (team in it.launchErrors) it.copy(launchErrors = it.launchErrors - team) else it }
}

/** Booting, with no send's own waking notice over it. */
internal fun startingDock(word: SessionWord?, sendAwaitingWake: Boolean): Boolean =
	!sendAwaitingWake && (word == SessionWord.VERIFYING || word == SessionWord.WAKING)
