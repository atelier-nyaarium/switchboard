package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver

/** An open conversation's session, view, and Files stack. */
internal data class ConversationNav(
	val team: String,
	val view: ConversationView,
	val files: List<WorkspacePlace>,
)

/** A menu pick made inside a session, drawn over it. */
internal data class OverNav(val view: RootView, val filtered: Boolean)

/** Where the shell stands. Every road through it is a transition on this value. */
internal data class ShellNav(
	val root: RootView = RootView.SESSIONS,
	val conversation: ConversationNav? = null,
	/** Only while a conversation is open. */
	val over: OverNav? = null,
	val settings: SettingsRoute? = null,
	val assistantPage: AssistantPage? = null,
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
		over = null,
		settings = null,
		assistantPage = null,
		generation = if (reopens) generation + 1 else generation,
	)
}

/** The assistant: its own root, no Files. */
internal fun ShellNav.arriveAt(
	team: String,
	assistant: Boolean,
	arrival: Arrival,
	facts: ArrivalFacts,
	place: WorkspacePlace? = null,
): ShellNav {
	val nextRoot = when {
		assistant -> RootView.ASSISTANT
		root == RootView.ASSISTANT -> RootView.SESSIONS
		else -> root
	}
	val how = if (assistant && arrival == Arrival.FILES_ASKED) Arrival.OUTSIDE else arrival
	return copy(root = nextRoot).arrive(team, how, facts, place.takeUnless { assistant })
}

/** Moves the open conversation's address. */
internal fun ShellNav.retarget(team: String): ShellNav = copy(conversation = conversation?.copy(team = team))

internal fun ShellNav.leave(): ShellNav = copy(conversation = null, over = null)

/** Forget closes only the shown session. */
internal fun ShellNav.forgot(team: String): ShellNav = if (conversation?.team == team) leave() else this

internal fun ShellNav.showView(view: ConversationView): ShellNav = copy(conversation = conversation?.copy(view = view))

internal fun ShellNav.showRoot(view: RootView): ShellNav = copy(root = view)

/** The menu's pick. Inside a session it lands over it, filtered where the view takes a session. */
internal fun ShellNav.pick(view: RootView, assistantOpen: Boolean): ShellNav = when {
	conversation == null -> showRoot(view)
	view == RootView.ASSISTANT && assistantOpen -> copy(over = null)
	view == RootView.SESSIONS || view == RootView.ASSISTANT -> leave().showRoot(view)
	else -> copy(over = OverNav(view, filtered = view.scoped != null && !assistantOpen))
}

/** A saved entry returns to the session, else to Sessions. */
internal fun ShellNav.boardSaved(): ShellNav = if (over != null) copy(over = null) else showRoot(RootView.SESSIONS)

/** The chip: this session, or everything. */
internal fun ShellNav.filter(on: Boolean): ShellNav = copy(over = over?.copy(filtered = on))

/** A page's exit to a root view. */
internal fun ShellNav.toRoot(view: RootView, assistantOpen: Boolean): ShellNav = copy(assistantPage = null).pick(view, assistantOpen)

/** A pick whose view stopped being offered returns to its session. */
internal fun ShellNav.offering(offered: List<RootView>): ShellNav = if (over != null && over.view !in offered) copy(over = null) else this

/** The root view drawn. */
internal fun ShellNav.rootShown(offered: List<RootView>): RootView = shownView(offered, over?.view ?: root)

/** The menu's selected row. */
internal fun ShellNav.menuShown(offered: List<RootView>, assistantOpen: Boolean): RootView = when {
	conversation == null || over != null -> rootShown(offered)
	assistantOpen -> RootView.ASSISTANT
	else -> RootView.SESSIONS
}

internal fun ShellNav.pushFiles(place: WorkspacePlace): ShellNav =
	copy(conversation = conversation?.let { it.copy(files = pushPlace(it.files, place)) })

internal fun ShellNav.popFiles(): ShellNav = copy(conversation = conversation?.let { it.copy(files = popPlace(it.files)) })

internal fun ShellNav.jumpFiles(place: WorkspacePlace): ShellNav =
	copy(conversation = conversation?.let { it.copy(files = jumpPlace(it.files, place)) })

internal fun ShellNav.openSettings(route: SettingsRoute = SettingsRoute.HUB): ShellNav = copy(settings = route)

internal fun ShellNav.closeSettings(): ShellNav = copy(settings = null)

internal fun ShellNav.openAssistantPage(page: AssistantPage): ShellNav = copy(assistantPage = page)

/** Its root, its own pages, any page over its conversation, or that conversation, when drawn. */
internal fun ShellNav.showsAssistant(assistantOpen: Boolean, screen: ShellScreen): Boolean = when (screen) {
	ShellScreen.ASSISTANT_PAGE -> assistantOpen || assistantPage?.own == true
	ShellScreen.CONVERSATION -> assistantOpen
	ShellScreen.ROOT -> over == null && root == RootView.ASSISTANT
	else -> false
}

/** The drawn view lists what the home answers. */
internal fun ShellNav.readsHome(assistantOpen: Boolean, screen: ShellScreen, offered: List<RootView>): Boolean =
	screen == ShellScreen.ASSISTANT_PAGE || showsAssistant(assistantOpen, screen) ||
		(screen == ShellScreen.ROOT && rootShown(offered) in HOME_LISTS)

private val HOME_LISTS = setOf(RootView.SOURCES, RootView.AUTOMATIONS)

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

/** Screens under the menu's drawer. */
internal val MENU_SCREENS = setOf(ShellScreen.CONVERSATION, ShellScreen.ROOT)

/** The one screen the shell draws, first match wins. */
internal enum class ShellScreen {
	LOCK,
	OVERLAY,
	SETTINGS,
	BOOT,
	ASSISTANT_PAGE,
	CONVERSATION,
	ROOT,
}

internal fun shellScreen(nav: ShellNav, locked: Boolean, overlayOpen: Boolean, booted: Boolean): ShellScreen = when {
	locked -> ShellScreen.LOCK
	overlayOpen -> ShellScreen.OVERLAY
	nav.settings != null -> ShellScreen.SETTINGS
	!booted -> ShellScreen.BOOT
	nav.assistantPage != null -> ShellScreen.ASSISTANT_PAGE
	nav.conversation != null && nav.over == null -> ShellScreen.CONVERSATION
	else -> ShellScreen.ROOT
}

/** Back follows draw order, not handler composition order. */
internal enum class BackLayer {
	EDITOR,
	OVERLAY,
	SETTINGS,
	ASSISTANT_PAGE,
	DRAWER,
	OVER,
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
	val assistantOpen: Boolean = false,
)

/** Null lets the system handle Back. Editors draw over every screen but the lock, so they go next. */
internal fun backLayer(nav: ShellNav, facts: BackFacts): BackLayer? {
	if (facts.locked) return null
	if (facts.editorOpen) return BackLayer.EDITOR
	val open = nav.conversation
	return when (shellScreen(nav, facts.locked, facts.overlayOpen, facts.booted)) {
		ShellScreen.LOCK, ShellScreen.BOOT -> null
		ShellScreen.OVERLAY -> BackLayer.OVERLAY
		ShellScreen.SETTINGS -> BackLayer.SETTINGS
		ShellScreen.ASSISTANT_PAGE -> BackLayer.ASSISTANT_PAGE
		ShellScreen.CONVERSATION, ShellScreen.ROOT -> when {
			facts.drawerOpen -> BackLayer.DRAWER
			nav.over != null -> BackLayer.OVER
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
	BackLayer.ASSISTANT_PAGE -> copy(assistantPage = assistantPage?.let(::assistantPageBack))
	BackLayer.OVER -> copy(over = null)
	BackLayer.FILES -> popFiles()
	BackLayer.VIEW -> showView(facts.offeredConversation.first())
	BackLayer.CONVERSATION -> if (facts.assistantOpen) leave().showRoot(RootView.SESSIONS) else leave()
	BackLayer.ROOT_VIEW -> showRoot(facts.offeredRoot.first())
	BackLayer.EDITOR, BackLayer.OVERLAY, BackLayer.DRAWER -> this
}

/** The arrow: the assistant steps, a session leaves. */
internal fun ShellNav.up(facts: BackFacts): ShellNav {
	val open = conversation ?: return this
	if (!facts.assistantOpen) return leave()
	val shown = shownView(facts.offeredConversation, open.view)
	val layer = if (backFrom(facts.offeredConversation, shown) != null) BackLayer.VIEW else BackLayer.CONVERSATION
	return back(layer, facts, provisioned = true)
}

/** Root, settings, pages persist. */
internal val ShellNavSaver: Saver<ShellNav, Any> = listSaver(
	save = { listOf(it.root.name, it.settings?.name.orEmpty()) + it.assistantPage?.let(::pageWords).orEmpty() },
	restore = { saved ->
		ShellNav(
			root = RootView.entries.firstOrNull { it.name == saved.getOrNull(0) } ?: RootView.SESSIONS,
			settings = SettingsRoute.entries.firstOrNull { it.name == saved.getOrNull(1) },
			assistantPage = pageOf(saved.drop(2).map { it.toString() }),
		)
	},
)
