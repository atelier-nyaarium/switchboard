package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver

/** A conversation and its pick. */
internal data class ConversationNav(
	val team: String,
	val view: ConversationView,
	val files: List<WorkspacePlace>,
	/** Arrived as the assistant's. */
	val assistant: Boolean,
	val over: OverNav?,
)

/** A menu pick made inside a session. `filtered` is its chip. */
internal data class OverNav(val view: RootView, val filtered: Boolean)

/** Facts read by a transition, not owned by it. */
internal data class ArrivalFacts(val offered: List<ConversationView>, val stuckAtLogin: Boolean)

/** Where the shell stands. Readers read [drawn]. */
@ConsistentCopyVisibility
internal data class ShellNav private constructor(
	/** The view beneath. */
	private val root: RootView,
	private val conversation: ConversationNav?,
	private val settings: SettingsRoute?,
	/** Top last. */
	private val pages: List<ShellPage>,
	/** Bumped on open to re-snap. */
	private val generation: Int,
) {
	constructor() : this(RootView.SESSIONS, null, null, emptyList(), 0)

	/** Drawn, or beneath a pick or a page. */
	val heldTeam: String? get() = conversation?.team

	/** What is on screen. */
	fun drawn(facts: ShellFacts): Drawn {
		val open = conversation
		val over = open?.over
		return when {
			facts.locked -> Drawn.Lock
			facts.overlayOpen -> Drawn.Overlay
			settings != null -> Drawn.Settings(settings)
			!facts.booted -> Drawn.Boot
			pages.isNotEmpty() -> Drawn.Page(pages.last(), overAssistant = facts.assistantOpen)
			open != null && over == null ->
				Drawn.Conversation(open.team, shownView(facts.offeredConversation, open.view), open.files, facts.assistantOpen, generation)
			else -> Drawn.Root(shownView(facts.offeredRoot, over?.view ?: root), open?.let { overOf(it.team, over, facts.assistantOpen) })
		}
	}

	/** A ref names its place; other arrivals retain Files only for the same session. */
	fun arrive(team: String, arrival: Arrival, facts: ArrivalFacts, place: WorkspacePlace? = null): ShellNav =
		landed(team, assistant = false, arrival, facts, place)

	/** The assistant: own root, no Files. */
	fun arriveAt(team: String, assistant: Boolean, arrival: Arrival, facts: ArrivalFacts, place: WorkspacePlace? = null): ShellNav {
		val nextRoot = when {
			assistant -> RootView.ASSISTANT
			root == RootView.ASSISTANT -> RootView.SESSIONS
			else -> root
		}
		val how = if (assistant && arrival == Arrival.FILES_ASKED) Arrival.OUTSIDE else arrival
		return copy(root = nextRoot).landed(team, assistant, how, facts, place.takeUnless { assistant })
	}

	private fun landed(team: String, assistant: Boolean, arrival: Arrival, facts: ArrivalFacts, place: WorkspacePlace?): ShellNav {
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
			conversation = ConversationNav(team, view, files, assistant, over = null),
			settings = null,
			pages = emptyList(),
			generation = if (reopens) generation + 1 else generation,
		)
	}

	/** Moves the open conversation's address. */
	fun retarget(team: String): ShellNav = copy(conversation = conversation?.copy(team = team))

	fun leave(): ShellNav = copy(conversation = null)

	/** Forget closes only the shown session. */
	fun forgot(team: String): ShellNav = if (conversation?.team == team) leave() else this

	fun showView(view: ConversationView): ShellNav = copy(conversation = conversation?.copy(view = view))

	fun showRoot(view: RootView): ShellNav = copy(root = view)

	private fun withOver(over: OverNav?): ShellNav = copy(conversation = conversation?.copy(over = over))

	/** Inside a session, lands over it. */
	fun pick(view: RootView, assistantOpen: Boolean): ShellNav = when {
		conversation == null -> showRoot(view)
		view == RootView.ASSISTANT && assistantOpen -> withOver(null)
		view == RootView.SESSIONS || view == RootView.ASSISTANT -> leave().showRoot(view)
		else -> withOver(OverNav(view, filtered = true))
	}

	/** Saved entry returns to session. */
	fun boardSaved(): ShellNav = if (conversation?.over != null) withOver(null) else showRoot(RootView.SESSIONS)

	/** The chip: this session, or everything. */
	fun filter(on: Boolean): ShellNav = conversation?.over?.let { withOver(it.copy(filtered = on)) } ?: this

	/** A page's exit to a root view. */
	fun toRoot(view: RootView, assistantOpen: Boolean): ShellNav = copy(pages = emptyList()).pick(view, assistantOpen)

	/** A pick whose view stopped being offered returns to its session. */
	fun offering(offered: List<RootView>): ShellNav {
		val over = conversation?.over ?: return this
		return if (over.view in offered) this else withOver(null)
	}

	fun pushFiles(place: WorkspacePlace): ShellNav = copy(conversation = conversation?.let { it.copy(files = pushPlace(it.files, place)) })

	fun popFiles(): ShellNav = copy(conversation = conversation?.let { it.copy(files = popPlace(it.files)) })

	fun jumpFiles(place: WorkspacePlace): ShellNav = copy(conversation = conversation?.let { it.copy(files = jumpPlace(it.files, place)) })

	fun openSettings(route: SettingsRoute = SettingsRoute.HUB): ShellNav = copy(settings = route)

	fun closeSettings(): ShellNav = copy(settings = null)

	/** A repeat of the top is ignored. */
	fun push(page: ShellPage): ShellNav = if (pages.lastOrNull() == page) this else copy(pages = pages + page)

	/** The top becomes [page]; a repeat of the one beneath collapses. */
	fun replaceTop(page: ShellPage): ShellNav = copy(pages = pages.dropLast(1)).push(page)

	fun pop(): ShellNav = copy(pages = pages.dropLast(1))

	/** Drops gone pages, collapses adjacent repeats. */
	fun resolvePages(state: ChatState, devices: (String) -> DeviceListView? = { null }): ShellNav {
		val now = pages.mapNotNull { it.resolved(state, devices) }
			.fold(emptyList<ShellPage>()) { kept, page -> if (kept.lastOrNull() == page) kept else kept + page }
		return if (now == pages) this else copy(pages = now)
	}

	/** Placed entry preserves pages. */
	fun enterAssistant(home: AssistantRoot, facts: (String) -> ArrivalFacts): ShellNav {
		if (root != RootView.ASSISTANT || conversation != null || settings != null) return this
		val placed = home as? AssistantRoot.Placed ?: return this
		return arriveAt(placed.team, assistant = true, Arrival.OUTSIDE, facts(placed.team)).copy(pages = pages)
	}

	/** Moves retarget; a home elsewhere, nobody, or a refusal leaves. */
	fun followAssistant(home: AssistantRoot, state: ChatState): ShellNav {
		val open = conversation?.takeIf { it.assistant } ?: return this
		return when {
			home is AssistantRoot.Placed -> if (home.team != open.team) retarget(home.team) else this
			assistantLeft(state, gatewayOf(open.team)) || homeRefusal(state) != null -> leave()
			else -> this
		}
	}

	fun summonedTo(landing: SummonLanding, facts: (String) -> ArrivalFacts): ShellNav = when (landing) {
		is SummonLanding.At -> arriveAt(landing.team, assistant = true, Arrival.OUTSIDE, facts(landing.team))
		SummonLanding.Root -> leave().copy(root = RootView.ASSISTANT, settings = null, pages = emptyList())
		SummonLanding.Configure -> leave().copy(root = RootView.ASSISTANT, settings = null, pages = listOf(ShellPage.Settings))
	}

	/** Navigation handles state; owners close editors, overlays, and drawers. */
	fun back(layer: BackLayer, facts: ShellFacts, provisioned: Boolean): ShellNav = when (layer) {
		BackLayer.SETTINGS -> copy(settings = settings?.let { settingsBack(it, provisioned) })
		BackLayer.PAGE -> pop()
		BackLayer.OVER -> withOver(null)
		BackLayer.FILES -> popFiles()
		BackLayer.VIEW -> showView(facts.offeredConversation.first())
		BackLayer.CONVERSATION -> if (facts.assistantOpen) leave().showRoot(RootView.SESSIONS) else leave()
		BackLayer.ROOT_VIEW -> showRoot(facts.offeredRoot.first())
		BackLayer.EDITOR, BackLayer.OVERLAY, BackLayer.DRAWER -> this
	}

	/** The arrow: the assistant steps, a session leaves. */
	fun up(facts: ShellFacts): ShellNav {
		val open = conversation ?: return this
		if (!facts.assistantOpen) return leave()
		val shown = shownView(facts.offeredConversation, open.view)
		val layer = if (backFrom(facts.offeredConversation, shown) != null) BackLayer.VIEW else BackLayer.CONVERSATION
		return back(layer, facts, provisioned = true)
	}

	companion object {
		/** Root, settings and pages; a restored page lies over the root view. */
		val saver: Saver<ShellNav, Any> = listSaver(
			save = { listOf(it.root.name, it.settings?.name.orEmpty()) + it.pages.map(::pageKey) },
			restore = { saved ->
				ShellNav(
					root = RootView.entries.firstOrNull { it.name == saved.getOrNull(0) } ?: RootView.SESSIONS,
					conversation = null,
					settings = SettingsRoute.entries.firstOrNull { it.name == saved.getOrNull(1) },
					pages = saved.drop(2).mapNotNull { pageOf(it.toString().split(Char(0x1e))) },
					generation = 0,
				)
			},
		)
	}
}

/** A pick over a session, and its filter. */
internal data class Over(val team: String, val filterable: Boolean, val scope: ViewScope)

/** The assistant's session filters nothing. */
private fun overOf(team: String, over: OverNav?, assistantOpen: Boolean): Over? {
	val held = over ?: return null
	val filterable = !assistantOpen && held.view.scoped != null
	return Over(team, filterable, if (filterable && held.filtered) ViewScope.Session(team) else ViewScope.Everything)
}

/** What the shell draws, first match wins. */
internal sealed interface Drawn {
	data object Lock : Drawn

	data object Boot : Drawn

	data object Overlay : Drawn

	data class Settings(val route: SettingsRoute) : Drawn

	data class Page(val page: ShellPage, val overAssistant: Boolean) : Drawn

	data class Conversation(
		val team: String,
		/** The view shown. */
		val view: ConversationView,
		val files: List<WorkspacePlace>,
		val assistant: Boolean,
		val openNonce: Int,
	) : Drawn

	data class Root(val view: RootView, val over: Over?) : Drawn
}

/** The one screen the shell draws. */
internal enum class ShellScreen {
	LOCK,
	OVERLAY,
	SETTINGS,
	BOOT,
	PAGE,
	CONVERSATION,
	ROOT,
}

internal val Drawn.kind: ShellScreen
	get() = when (this) {
		Drawn.Lock -> ShellScreen.LOCK
		Drawn.Overlay -> ShellScreen.OVERLAY
		is Drawn.Settings -> ShellScreen.SETTINGS
		Drawn.Boot -> ShellScreen.BOOT
		is Drawn.Page -> ShellScreen.PAGE
		is Drawn.Conversation -> ShellScreen.CONVERSATION
		is Drawn.Root -> ShellScreen.ROOT
	}

/** Screens under the menu's drawer. */
internal val MENU_SCREENS = setOf(ShellScreen.CONVERSATION, ShellScreen.ROOT)

/** The menu's selected row; Sessions where no menu is drawn. */
internal fun menuShown(drawn: Drawn): RootView = when (drawn) {
	is Drawn.Root -> drawn.view
	is Drawn.Conversation -> if (drawn.assistant) RootView.ASSISTANT else RootView.SESSIONS
	else -> RootView.SESSIONS
}

/** Its root, its own pages, any page over its conversation, or that conversation, when drawn. */
internal fun showsAssistant(drawn: Drawn): Boolean = when (drawn) {
	is Drawn.Page -> drawn.overAssistant || drawn.page.own
	is Drawn.Conversation -> drawn.assistant
	is Drawn.Root -> drawn.over == null && drawn.view == RootView.ASSISTANT
	else -> false
}

/** The drawn view lists what the home answers. */
internal fun readsHome(drawn: Drawn): Boolean =
	drawn is Drawn.Page || showsAssistant(drawn) || (drawn is Drawn.Root && drawn.view in HOME_LISTS)

/** A home read's key: the screen and its root view. Null reads nothing. */
internal fun homeReadKey(drawn: Drawn): Pair<ShellScreen, RootView?>? =
	if (readsHome(drawn)) drawn.kind to (drawn as? Drawn.Root)?.view else null

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

/** Back follows draw order, not handler composition order. */
internal enum class BackLayer {
	EDITOR,
	OVERLAY,
	SETTINGS,
	PAGE,
	DRAWER,
	OVER,
	FILES,
	VIEW,
	CONVERSATION,
	ROOT_VIEW,
}

/** Facts the shell reads beside navigation state. */
internal data class ShellFacts(
	val editorOpen: Boolean,
	val locked: Boolean,
	val overlayOpen: Boolean,
	val booted: Boolean,
	val drawerOpen: Boolean,
	val offeredRoot: List<RootView>,
	val offeredConversation: List<ConversationView>,
	val assistantOpen: Boolean = false,
)

internal fun backLayer(nav: ShellNav, facts: ShellFacts): BackLayer? = backLayer(nav.drawn(facts), facts)

/** Null lets the system handle Back. Editors draw over every screen but the lock, so they go next. */
internal fun backLayer(drawn: Drawn, facts: ShellFacts): BackLayer? {
	if (drawn == Drawn.Lock) return null
	if (facts.editorOpen) return BackLayer.EDITOR
	return when (drawn) {
		Drawn.Lock, Drawn.Boot -> null
		Drawn.Overlay -> BackLayer.OVERLAY
		is Drawn.Settings -> BackLayer.SETTINGS
		is Drawn.Page -> BackLayer.PAGE
		is Drawn.Root -> when {
			facts.drawerOpen -> BackLayer.DRAWER
			drawn.over != null -> BackLayer.OVER
			else -> BackLayer.ROOT_VIEW.takeIf { backFrom(facts.offeredRoot, drawn.view) != null }
		}
		is Drawn.Conversation -> when {
			facts.drawerOpen -> BackLayer.DRAWER
			drawn.view == ConversationView.FILES && drawn.files.size > 1 -> BackLayer.FILES
			backFrom(facts.offeredConversation, drawn.view) != null -> BackLayer.VIEW
			else -> BackLayer.CONVERSATION
		}
	}
}
