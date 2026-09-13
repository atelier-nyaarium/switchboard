package com.atelier_nyaarium.switchboard

/** A stack, so Back is one rule rather than a flag per screen. */
internal sealed interface WorkspacePlace {
	/** Empty is the workspace root. */
	data class Tree(val path: String) : WorkspacePlace

	data class Outline(val path: String) : WorkspacePlace

	/** Whole file, no Lexicon. */
	data class Raw(val path: String) : WorkspacePlace

	data class Detail(val symbolId: String, val module: String) : WorkspacePlace

	data object Windows : WorkspacePlace
}

internal data class Crumb(val label: String, val path: String)

internal val WORKSPACE_ROOT: WorkspacePlace = WorkspacePlace.Tree("")

internal fun placeOf(stack: List<WorkspacePlace>): WorkspacePlace = stack.lastOrNull() ?: WORKSPACE_ROOT

/** A repeat of where we already are is not a step, or Back would need pressing twice. */
internal fun pushPlace(stack: List<WorkspacePlace>, place: WorkspacePlace): List<WorkspacePlace> =
	if (stack.lastOrNull() == place) stack else stack + place

/** The root never pops, so the tab cannot be left showing nothing. */
internal fun popPlace(stack: List<WorkspacePlace>): List<WorkspacePlace> =
	if (stack.size <= 1) listOf(WORKSPACE_ROOT) else stack.dropLast(1)

/** A breadcrumb or the up row: back to that place when it is on the stack, onto it when not. */
internal fun jumpPlace(stack: List<WorkspacePlace>, place: WorkspacePlace): List<WorkspacePlace> {
	val at = stack.lastIndexOf(place)
	return if (at >= 0) stack.take(at + 1) else pushPlace(stack, place)
}

/** A detail names its file, since the screen draws the symbol's name. */
internal fun placeTitle(place: WorkspacePlace): String =
	when (place) {
		is WorkspacePlace.Tree -> place.path.ifEmpty { "Files" }
		is WorkspacePlace.Outline -> place.path.substringAfterLast('/')
		is WorkspacePlace.Raw -> place.path.substringAfterLast('/')
		is WorkspacePlace.Detail -> place.module.substringAfterLast('/')
		WorkspacePlace.Windows -> "Windows"
	}

/** The directory a tree row opens, with no leading separator at the root. */
internal fun childPath(parent: String, name: String): String = if (parent.isEmpty()) name else "$parent/$name"

internal fun parentPath(path: String): String = path.substringBeforeLast('/', "")

/** The root's last segment, or "Files" from a plugin that does not name it. */
internal fun projectName(root: String?): String = root?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null } ?: "Files"

/** What the root crumb follows, drawn dim. */
internal fun rootPrefix(root: String?): String {
	val trimmed = root?.trimEnd('/') ?: return ""
	return if ('/' in trimmed) trimmed.substringBeforeLast('/') + "/" else ""
}

internal fun crumbsOf(root: String?, folder: String): List<Crumb> {
	val parts = folder.split('/').filter { it.isNotEmpty() }
	return listOf(Crumb(projectName(root), "")) + parts.indices.map { Crumb(parts[it], parts.take(it + 1).joinToString("/")) }
}

/** Only a session holds a workspace; a spawn point has no plugin, and the gateway refuses it. */
internal fun holdsWorkspace(team: Team): Boolean = addressOf(team.name) != null

internal fun targetOf(team: Team): WorkspaceTarget = WorkspaceTarget(gatewayId = team.gatewayId, address = team.name)

/** Request disposition for the current roster. */
internal enum class RequestStanding {
	/** The roster has not answered yet, and an absent session is not yet a missing one. */
	Wait,

	Show,

	/** Dropped, or it navigates long after the tap. */
	Drop,
}

internal fun standingOf(teams: List<Team>, rosterLoaded: Boolean, team: String): RequestStanding =
	when {
		teams.any { it.name == team && holdsWorkspace(it) } -> RequestStanding.Show
		rosterLoaded -> RequestStanding.Drop
		else -> RequestStanding.Wait
	}
