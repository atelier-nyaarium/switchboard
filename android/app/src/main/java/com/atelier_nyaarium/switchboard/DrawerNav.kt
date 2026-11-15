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
	ROUTINES("Routines"),
	RUNBOOKS("Runbooks"),
	VAULT("Vault"),
	POLICIES("Policies"),
	CONSOLE("Console"),
}

/** The one menu, in its order. A divider falls between groups. */
enum class RootView(val title: String, val scoped: ScopedView?, val group: Int) {
	SESSIONS("Sessions", null, 0),
	ASSISTANT("Assistant", null, 0),
	BACKLOG("Backlog", ScopedView.BACKLOG, 0),
	SOURCES("Sources", null, 1),
	AUTOMATIONS("Automations", null, 1),
	ROUTINES("Routines", ScopedView.ROUTINES, 1),
	RUNBOOKS("Runbooks", ScopedView.RUNBOOKS, 1),
	VAULT("Vault", ScopedView.VAULT, 2),
	POLICIES("Policies", ScopedView.POLICIES, 2),
	CONSOLE("Console", ScopedView.CONSOLE, 2),
}

/** How a session is shown. */
enum class ConversationView(val title: String) {
	CHAT("Chat"),
	TERMINAL("Terminal"),
	FILES("Files"),
}

internal data class DrawerFeatures(val board: Boolean, val vault: Boolean)

private fun ScopedView.offeredWith(features: DrawerFeatures): Boolean = when (this) {
	ScopedView.BACKLOG -> features.board
	ScopedView.POLICIES, ScopedView.VAULT -> features.vault
	ScopedView.RUNBOOKS, ScopedView.ROUTINES, ScopedView.CONSOLE -> true
}

internal fun rootViews(features: DrawerFeatures): List<RootView> =
	RootView.entries.filter { it.scoped?.offeredWith(features) ?: true }

/** The assistant has no Files. */
internal fun conversationViews(terminal: Boolean, assistant: Boolean): List<ConversationView> = listOfNotNull(
	ConversationView.CHAT,
	ConversationView.TERMINAL.takeIf { terminal },
	ConversationView.FILES.takeUnless { assistant },
)

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

/** Pending requests badge the Vault row. */
internal fun rootBadge(view: RootView, pendingRequests: Int): Int? =
	pendingRequests.takeIf { view == RootView.VAULT && it > 0 }

/** A badged row marks the closed drawer. */
internal fun anyBadge(badges: List<Int?>): Boolean = badges.any { it != null }

internal fun addressOf(team: String): Address? = runIsolated { parseQualifiedTarget(team) }.getOrNull() as? Address
