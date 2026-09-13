package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget

enum class DrawerSide {
	LEFT,
	RIGHT,
	;

	companion object {
		fun of(stored: String?): DrawerSide = entries.firstOrNull { it.name == stored } ?: RIGHT
	}
}

enum class ScopedView(val title: String) {
	BACKLOG("Backlog"),
	RUNBOOKS("Runbooks"),
	ROUTINES("Routines"),
	POLICIES("Policies"),
	VAULT("Vault"),
}

enum class RootView(val title: String, val scoped: ScopedView?) {
	SESSIONS("Sessions", null),
	BACKLOG("Backlog", ScopedView.BACKLOG),
	RUNBOOKS("Runbooks", ScopedView.RUNBOOKS),
	ROUTINES("Routines", ScopedView.ROUTINES),
	POLICIES("Policies", ScopedView.POLICIES),
	VAULT("Vault", ScopedView.VAULT),
	;

	companion object {
		fun of(scoped: ScopedView): RootView = entries.first { it.scoped == scoped }
	}
}

enum class ConversationView(val title: String, val scoped: ScopedView?) {
	CHAT("Chat", null),
	TERMINAL("Terminal", null),
	FILES("Files", null),
	BACKLOG("Backlog", ScopedView.BACKLOG),
	RUNBOOKS("Runbooks", ScopedView.RUNBOOKS),
	ROUTINES("Routines", ScopedView.ROUTINES),
	POLICIES("Policies", ScopedView.POLICIES),
	VAULT("Vault", ScopedView.VAULT),
}

internal data class DrawerFeatures(val board: Boolean, val vault: Boolean)

private fun ScopedView.offeredWith(features: DrawerFeatures): Boolean = when (this) {
	ScopedView.BACKLOG -> features.board
	ScopedView.POLICIES, ScopedView.VAULT -> features.vault
	ScopedView.RUNBOOKS, ScopedView.ROUTINES -> true
}

internal fun rootViews(features: DrawerFeatures): List<RootView> =
	RootView.entries.filter { it.scoped?.offeredWith(features) ?: true }

internal fun conversationViews(features: DrawerFeatures, terminal: Boolean): List<ConversationView> =
	ConversationView.entries.filter {
		when {
			it == ConversationView.TERMINAL -> terminal
			else -> it.scoped?.offeredWith(features) ?: true
		}
	}

/** Unoffered views fall back. */
internal fun <V> shownView(offered: List<V>, held: V): V = if (held in offered) held else offered.first()

/** Back leaves after the first view. */
internal fun <V> backFrom(offered: List<V>, shown: V): V? = offered.first().takeIf { it != shown }

internal enum class Arrival {
	/** The root or a notification. */
	OUTSIDE,

	/** The tab row. */
	TAB,

	/** A ref's exit. */
	FILES_ASKED,
}

/** A ref's exit, then a login prompt, then how it arrived. */
internal fun arrivedView(
	held: ConversationView,
	offered: List<ConversationView>,
	arrival: Arrival,
	stuckAtLogin: Boolean,
): ConversationView = when {
	arrival == Arrival.FILES_ASKED -> ConversationView.FILES
	stuckAtLogin && ConversationView.TERMINAL in offered -> ConversationView.TERMINAL
	arrival == Arrival.OUTSIDE -> ConversationView.CHAT
	else -> held
}

internal sealed interface DrawerMark {
	data class Detail(val text: String) : DrawerMark

	data class Badge(val count: Int) : DrawerMark
}

internal data class ConversationFacts(
	val team: String,
	val openWindows: Int,
	val undoneTasks: Int,
	val pendingRequests: Int,
)

internal fun conversationMark(view: ConversationView, facts: ConversationFacts): DrawerMark? = when (view) {
	ConversationView.CHAT, ConversationView.TERMINAL -> null
	ConversationView.FILES -> windowsDetail(facts.openWindows)
	ConversationView.BACKLOG -> facts.undoneTasks.takeIf { it > 0 }?.let { DrawerMark.Detail("$it open") }
	ConversationView.RUNBOOKS, ConversationView.POLICIES -> addressOf(facts.team)?.let { DrawerMark.Detail(it.gateway) }
	ConversationView.ROUTINES -> addressOf(facts.team)?.let { DrawerMark.Detail(it.spawn) }
	ConversationView.VAULT -> facts.pendingRequests.takeIf { it > 0 }?.let { DrawerMark.Badge(it) }
}

private fun windowsDetail(count: Int): DrawerMark? = when (count) {
	0 -> null
	1 -> DrawerMark.Detail("1 window")
	else -> DrawerMark.Detail("$count windows")
}

internal fun rootMark(view: RootView, pendingRequests: Int): DrawerMark? =
	if (view == RootView.VAULT && pendingRequests > 0) DrawerMark.Badge(pendingRequests) else null

/** Badges mark the closed drawer. */
internal fun anyBadge(marks: List<DrawerMark?>): Boolean = marks.any { it is DrawerMark.Badge }

internal fun addressOf(team: String): Address? = runCatching { parseQualifiedTarget(team) }.getOrNull() as? Address
