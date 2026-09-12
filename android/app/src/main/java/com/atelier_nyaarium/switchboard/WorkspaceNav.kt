package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget

/** Where the Files tab is. A stack, so Back is one rule rather than a flag per screen. */
internal sealed interface WorkspacePlace {
	/** An empty path is the workspace root. */
	data class Tree(val path: String) : WorkspacePlace

	data class Outline(val path: String) : WorkspacePlace

	/** The whole file as text, which Lexicon has no part in. */
	data class Raw(val path: String) : WorkspacePlace

	data class Detail(val symbolId: String, val name: String) : WorkspacePlace

	data object Windows : WorkspacePlace
}

internal val WORKSPACE_ROOT: WorkspacePlace = WorkspacePlace.Tree("")

internal fun placeOf(stack: List<WorkspacePlace>): WorkspacePlace = stack.lastOrNull() ?: WORKSPACE_ROOT

/** A repeat of where we already are is not a step, or Back would need pressing twice. */
internal fun pushPlace(stack: List<WorkspacePlace>, place: WorkspacePlace): List<WorkspacePlace> =
	if (stack.lastOrNull() == place) stack else stack + place

/** The root never pops, so the tab cannot be left showing nothing. */
internal fun popPlace(stack: List<WorkspacePlace>): List<WorkspacePlace> =
	if (stack.size <= 1) listOf(WORKSPACE_ROOT) else stack.dropLast(1)

/** What the header shows, and the only place a path is turned into a heading. */
internal fun placeTitle(place: WorkspacePlace): String =
	when (place) {
		is WorkspacePlace.Tree -> place.path.ifEmpty { "Files" }
		is WorkspacePlace.Outline -> place.path.substringAfterLast('/')
		is WorkspacePlace.Raw -> place.path.substringAfterLast('/')
		is WorkspacePlace.Detail -> place.name
		WorkspacePlace.Windows -> "Windows"
	}

/** The directory a tree row opens, with no leading separator at the root. */
internal fun childPath(parent: String, name: String): String = if (parent.isEmpty()) name else "$parent/$name"

/**
 * Only a session holds a workspace. A spawn point has no plugin of its own, and the gateway's console
 * handler refuses one, so offering it would offer a read nothing can answer.
 */
internal fun workspaceSessions(teams: List<Team>): List<Team> =
	teams.filter { runCatching { parseQualifiedTarget(it.name) }.getOrNull() is Address }.sortedBy { it.name }

internal fun targetOf(team: Team): WorkspaceTarget = WorkspaceTarget(gatewayId = team.gatewayId, address = team.name)

/**
 * The picked session, or the first one. Nothing picked is not a state worth showing: the field names
 * the one being read, so a default is visible rather than hidden, and only an empty roster draws
 * nothing. A pick the roster has dropped falls back the same way.
 */
internal fun pickedSession(sessions: List<Team>, picked: String?): Team? =
	sessions.firstOrNull { it.name == picked } ?: sessions.firstOrNull()
