package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver

/** An open conversation's session, view, and Files stack. */
internal data class ConversationNav(
	val team: String,
	val view: ConversationView,
	val files: List<WorkspacePlace>,
)

/** Where the shell stands. Every road through it is a transition on this value. */
internal data class ShellNav(
	val root: RootView = RootView.SESSIONS,
	val conversation: ConversationNav? = null,
	val settings: SettingsRoute? = null,
	/** Bumped on a genuine open to re-snap the thread to its first unread. */
	val generation: Int = 0,
)

/** Facts read by a transition, not owned by it. */
internal data class ArrivalFacts(val offered: List<ConversationView>, val stuckAtLogin: Boolean)

/** A ref names its place; other arrivals retain Files only for the same session. */
internal fun ShellNav.arrive(
	team: String,
	arrival: Arrival,
	facts: ArrivalFacts,
	place: WorkspacePlace? = null,
): ShellNav {
	val held = conversation
	val same = held?.team == team
	val view = arrivedView(held?.view ?: ConversationView.CHAT, facts.offered, arrival, facts.stuckAtLogin)
	val files = when {
		place != null -> pushPlace(listOf(WORKSPACE_ROOT), place)
		same && held != null -> held.files
		else -> listOf(WORKSPACE_ROOT)
	}
	val reopens = when (arrival) {
		Arrival.OUTSIDE -> true
		Arrival.CLOSED_TAB -> false
		Arrival.TAB, Arrival.FILES_ASKED -> !same
	}
	return copy(
		conversation = ConversationNav(team, view, files),
		settings = null,
		generation = if (reopens) generation + 1 else generation,
	)
}

internal fun ShellNav.leave(): ShellNav = copy(conversation = null)

/** Forget closes only the shown session. */
internal fun ShellNav.forgot(team: String): ShellNav = if (conversation?.team == team) leave() else this

internal fun ShellNav.showView(view: ConversationView): ShellNav = copy(conversation = conversation?.copy(view = view))

internal fun ShellNav.showRoot(view: RootView): ShellNav = copy(root = view)

/** A scoped view returns to its root view. */
internal fun ShellNav.wholeOf(view: ScopedView): ShellNav = copy(root = RootView.of(view), conversation = null)

internal fun ShellNav.pushFiles(place: WorkspacePlace): ShellNav =
	copy(conversation = conversation?.let { it.copy(files = pushPlace(it.files, place)) })

internal fun ShellNav.popFiles(): ShellNav = copy(conversation = conversation?.let { it.copy(files = popPlace(it.files)) })

internal fun ShellNav.openSettings(route: SettingsRoute = SettingsRoute.HUB): ShellNav = copy(settings = route)

internal fun ShellNav.closeSettings(): ShellNav = copy(settings = null)

/** Routes allowed before provisioning. */
private val PRE_PROVISION_ROUTES = setOf(SettingsRoute.HUB, SettingsRoute.SYSTEM, SettingsRoute.PLUGINS, SettingsRoute.FEDERATION)

/** Provisioned-only routes fall back to the hub before provisioning. */
internal fun effectiveRoute(route: SettingsRoute, provisioned: Boolean): SettingsRoute =
	if (!provisioned && route !in PRE_PROVISION_ROUTES) SettingsRoute.HUB else route

/** Federation returns to Domain & Trust when provisioned; null closes settings. */
internal fun settingsBack(route: SettingsRoute, provisioned: Boolean): SettingsRoute? =
	when (effectiveRoute(route, provisioned)) {
		SettingsRoute.HUB -> null
		SettingsRoute.FEDERATION -> if (provisioned) SettingsRoute.NETWORKS else SettingsRoute.HUB
		else -> SettingsRoute.HUB
	}

/** The one screen the shell draws, first match wins. */
internal enum class ShellScreen {
	LOCK,
	OVERLAY,
	SETTINGS,
	BOOT,
	CONVERSATION,
	ROOT,
}

internal fun shellScreen(nav: ShellNav, locked: Boolean, overlayOpen: Boolean, booted: Boolean): ShellScreen = when {
	locked -> ShellScreen.LOCK
	overlayOpen -> ShellScreen.OVERLAY
	nav.settings != null -> ShellScreen.SETTINGS
	!booted -> ShellScreen.BOOT
	nav.conversation != null -> ShellScreen.CONVERSATION
	else -> ShellScreen.ROOT
}

/** Back follows draw order, not handler composition order. */
internal enum class BackLayer {
	EDITOR,
	OVERLAY,
	SETTINGS,
	DRAWER,
	FILES,
	VIEW,
	CONVERSATION,
	ROOT_VIEW,
}

/** Facts Back reads beside navigation state. */
internal data class BackFacts(
	val editorOpen: Boolean,
	val locked: Boolean,
	val overlayOpen: Boolean,
	val booted: Boolean,
	val drawerOpen: Boolean,
	val offeredRoot: List<RootView>,
	val offeredConversation: List<ConversationView>,
)

/** Null lets the system handle Back. Editors draw over every screen, so they go first. */
internal fun backLayer(nav: ShellNav, facts: BackFacts): BackLayer? {
	if (facts.editorOpen) return BackLayer.EDITOR
	val open = nav.conversation
	return when (shellScreen(nav, facts.locked, facts.overlayOpen, facts.booted)) {
		ShellScreen.LOCK, ShellScreen.BOOT -> null
		ShellScreen.OVERLAY -> BackLayer.OVERLAY
		ShellScreen.SETTINGS -> BackLayer.SETTINGS
		ShellScreen.CONVERSATION, ShellScreen.ROOT -> when {
			facts.drawerOpen -> BackLayer.DRAWER
			open == null -> BackLayer.ROOT_VIEW.takeIf { backFrom(facts.offeredRoot, shownView(facts.offeredRoot, nav.root)) != null }
			shownView(facts.offeredConversation, open.view) == ConversationView.FILES && open.files.size > 1 -> BackLayer.FILES
			backFrom(facts.offeredConversation, shownView(facts.offeredConversation, open.view)) != null -> BackLayer.VIEW
			else -> BackLayer.CONVERSATION
		}
	}
}

/** Navigation handles state; owners close editors, overlays, and drawers. */
internal fun ShellNav.back(layer: BackLayer, facts: BackFacts, provisioned: Boolean): ShellNav = when (layer) {
	BackLayer.SETTINGS -> copy(settings = settings?.let { settingsBack(it, provisioned) })
	BackLayer.FILES -> popFiles()
	BackLayer.VIEW -> showView(facts.offeredConversation.first())
	BackLayer.CONVERSATION -> leave()
	BackLayer.ROOT_VIEW -> showRoot(facts.offeredRoot.first())
	BackLayer.EDITOR, BackLayer.OVERLAY, BackLayer.DRAWER -> this
}

/** Only root and settings survive recreation. */
internal val ShellNavSaver: Saver<ShellNav, Any> = listSaver(
	save = { listOf(it.root.name, it.settings?.name.orEmpty()) },
	restore = { saved ->
		ShellNav(
			root = RootView.entries.firstOrNull { it.name == saved.getOrNull(0) } ?: RootView.SESSIONS,
			settings = SettingsRoute.entries.firstOrNull { it.name == saved.getOrNull(1) },
		)
	},
)
