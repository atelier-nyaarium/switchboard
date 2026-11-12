package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

////////////////////////////////
//  Interfaces & Types

/** A failed launch, until dismissed or up. */
data class LaunchError(val line: String, val at: Long)

/** A session's launch dock. */
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

/** A failed launch docks, never threads. */
internal fun launchErrorOf(entry: MailboxEntry): LaunchError? {
	if (entry.kind != NOTICE_ROW || entry.launch != FAILED_ROW) return null
	val line = entry.body?.trim().orEmpty()
	return if (line.isEmpty()) null else LaunchError(line, entry.at)
}

/** Up clears a failed launch. */
internal fun launchErrorsAfter(held: Map<String, LaunchError>, fresh: List<Team>): Map<String, LaunchError> {
	if (held.isEmpty()) return held
	val up = fresh.filter { it.presence.isOnline }.mapTo(HashSet()) { it.name }
	return if (held.keys.none { it in up }) held else held - up
}

/** False when already up. */
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

/** Booting only. A pane mid-turn is reconnecting, which reads verifying too. */
internal fun startingDock(word: SessionWord?, sendAwaitingWake: Boolean, paneWorking: Boolean): Boolean =
	!sendAwaitingWake && !paneWorking && (word == SessionWord.VERIFYING || word == SessionWord.WAKING)
