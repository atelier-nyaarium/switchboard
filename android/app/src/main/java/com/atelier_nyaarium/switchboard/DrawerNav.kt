package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import kotlin.math.abs

enum class DrawerSide {
	LEFT,
	RIGHT,
	;

	companion object {
		fun of(stored: String?): DrawerSide = entries.firstOrNull { it.name == stored } ?: LEFT
	}
}

internal enum class DrawerSlot {
	CLOSED,
	LEFT,
	RIGHT,
}

internal fun slotOf(side: DrawerSide): DrawerSlot = if (side == DrawerSide.LEFT) DrawerSlot.LEFT else DrawerSlot.RIGHT

/** A shown drawer only closes. */
internal fun drawerAnchors(settled: DrawerSlot, width: Float): Map<DrawerSlot, Float> = when (settled) {
	DrawerSlot.CLOSED -> mapOf(DrawerSlot.CLOSED to 0f, DrawerSlot.LEFT to width, DrawerSlot.RIGHT to -width)
	DrawerSlot.LEFT -> mapOf(DrawerSlot.CLOSED to 0f, DrawerSlot.LEFT to width)
	DrawerSlot.RIGHT -> mapOf(DrawerSlot.CLOSED to 0f, DrawerSlot.RIGHT to -width)
}

// Within about 22 degrees of horizontal.
private const val SWIPE_RATIO = 2.5f

/** Null until past slop. A scroll's drift never claims. */
internal fun swipeClaim(dx: Float, dy: Float, slop: Float): Boolean? =
	if (dx * dx + dy * dy < slop * slop) null else abs(dx) >= abs(dy) * SWIPE_RATIO

/** Where a released drag settles. */
internal fun releasedSlot(offset: Float, velocity: Float, width: Float, fling: Float): DrawerSlot {
	val opening = slotShown(offset)
	if (opening == DrawerSlot.CLOSED) return DrawerSlot.CLOSED
	val outward = if (opening == DrawerSlot.LEFT) velocity else -velocity
	return when {
		outward > fling -> opening
		outward < -fling -> DrawerSlot.CLOSED
		abs(offset) > width / 2 -> opening
		else -> DrawerSlot.CLOSED
	}
}

internal fun slotShown(offset: Float): DrawerSlot = when {
	offset > 0.5f -> DrawerSlot.LEFT
	offset < -0.5f -> DrawerSlot.RIGHT
	else -> DrawerSlot.CLOSED
}

/** The sheet's left edge. */
internal fun sheetX(shown: DrawerSlot, offset: Float, width: Float, screen: Int): Float = when (shown) {
	DrawerSlot.LEFT -> offset - width
	DrawerSlot.RIGHT -> screen + offset
	DrawerSlot.CLOSED -> 0f
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

	/** The tab row, after the open tab closed. */
	CLOSED_TAB,

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
