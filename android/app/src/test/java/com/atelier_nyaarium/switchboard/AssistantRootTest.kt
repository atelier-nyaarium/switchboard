package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantRootTest {
	private val assistant = "dom.sakura.host.assistant"
	private val session = "dom.sakura.app.dev"
	private val facts = { team: String ->
		ArrivalFacts(
			offered = if (team == assistant) assistantConversationViews(terminal = true) else conversationViews(DrawerFeatures(true, true), true),
			stuckAtLogin = false,
		)
	}

	private fun backFacts(nav: ShellNav) = BackFacts(
		editorOpen = false,
		locked = false,
		overlayOpen = false,
		booted = true,
		drawerOpen = false,
		offeredRoot = rootViews(DrawerFeatures(true, true)),
		offeredConversation = nav.conversation?.team?.let { facts(it).offered }.orEmpty(),
		assistantOpen = nav.conversation?.team == assistant,
	)

	private val github = AssistantWatcher(
		id = "github",
		label = "GitHub",
		grants = emptyList(),
		unread = 0L,
		fields = listOf("reason"),
		rules = AssistantWatcherRules(emptyList(), AssistantRuleOtherwise(action = "inbox", revision = 0L), revision = 0L),
	)

	private fun placedOn(gatewayId: String, vararg others: String) = ChatState(
		domainId = "dom",
		gateways = testRegistry(gatewayId, *others).let { registry ->
			registry.copy(
				gateways = registry.gateways.map {
					it.copy(
						assistant = AssistantWord.Answered(
							ConsoleAssistantStateResult(
								workdir = "~/notes".takeIf { _ -> it.id == gatewayId },
								team = "host.assistant".takeIf { _ -> it.id == gatewayId },
								watchers = if (it.id == gatewayId) listOf(github) else emptyList(),
							),
						),
					)
				},
			)
		},
	)

	private val holdsNone = AssistantWord.Answered(ConsoleAssistantStateResult(watchers = emptyList()))

	private fun ChatState.withWord(gatewayId: String, word: AssistantWord?) =
		copy(gateways = gateways.withEntry(gatewayId) { it.copy(assistant = word) })

	@Test
	fun theAssistantArrivesUnderItsRootAndBackStepsTerminalChatSessions() {
		val inTerminal = ShellNav(root = RootView.ROUTINES)
			.arriveAt(assistant, assistant = true, Arrival.FILES_ASKED, facts(assistant), WorkspacePlace.Windows)
			.showView(ConversationView.TERMINAL)

		assertEquals(RootView.ASSISTANT, inTerminal.root)
		assertEquals(listOf(WORKSPACE_ROOT), inTerminal.conversation?.files)

		val inChat = inTerminal.up(backFacts(inTerminal))
		assertEquals(ConversationView.CHAT, inChat.conversation?.view)

		val left = inChat.back(backLayer(inChat, backFacts(inChat))!!, backFacts(inChat), provisioned = true)
		assertNull(left.conversation)
		assertEquals(RootView.SESSIONS, left.root)
		assertEquals(left, inChat.up(backFacts(inChat)))
	}

	@Test
	fun aSessionArrivingOverTheAssistantReturnsToSessionsAndBackLeavesAtOnce() {
		val nav = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.arriveAt(session, false, Arrival.OUTSIDE, facts(session))
			.showView(ConversationView.TERMINAL)

		assertEquals(RootView.SESSIONS, nav.root)
		assertNull(nav.up(backFacts(nav)).conversation)
	}

	@Test
	fun theAssistantIsOfferedChatAndTerminalAlone() {
		assertEquals(listOf(ConversationView.CHAT, ConversationView.TERMINAL), assistantConversationViews(terminal = true))
		assertEquals(listOf(ConversationView.CHAT), assistantConversationViews(terminal = false))
	}

	@Test
	fun theRootResolvesPlacedUnplacedLoadingAndUnavailable() {
		assertEquals(AssistantRoot.Placed(assistant), assistantRoot(placedOn("sakura", "mikan"), null))

		assertEquals(AssistantRoot.Unplaced, assistantRoot(placedOn("sakura").withWord("sakura", holdsNone), null))
		val refusedBesideEmpty = placedOn("mikan", "sakura").withWord("mikan", holdsNone).withWord("sakura", AssistantWord.Refused)
		assertEquals(AssistantRoot.Unavailable(canPlace = true), assistantRoot(refusedBesideEmpty, null))
		val refusedBesidePlaced = placedOn("mikan", "sakura").withWord("sakura", AssistantWord.Refused)
		assertEquals(AssistantRoot.Placed("dom.mikan.host.assistant"), assistantRoot(refusedBesidePlaced, null))

		val unread = ChatState(domainId = "dom", gateways = testRegistry("sakura"))
		assertEquals(AssistantRoot.Loading, assistantRoot(unread, null))

		val offline = unread.copy(gateways = unread.gateways.withEntry("sakura") { it.copy(connected = false) })
		assertEquals(AssistantRoot.Unavailable(canPlace = false), assistantRoot(offline, null))

		val homeOffline = placedOn("sakura").let { s -> s.copy(gateways = s.gateways.withEntry("sakura") { it.copy(connected = false) }) }
		assertEquals(AssistantRoot.Unavailable(canPlace = false), assistantRoot(homeOffline, null))
	}

	@Test
	fun openingATabRefusesTheAssistant() {
		val state = placedOn("sakura").copy(openTabs = listOf(session))

		assertNull(tabsAfterOpen(state, assistant))
		assertEquals(listOf(session), tabsAfterOpen(state, session))
		assertEquals(listOf(session, "dom.sakura.app.web"), tabsAfterOpen(state, "dom.sakura.app.web"))
	}

	@Test
	fun itIsKnownByItsGatewaysAnswerBeforeAnyPresenceRow() {
		val state = placedOn("sakura")

		assertTrue(isAssistant(state, assistant))
		assertFalse(isAssistant(state, "dom.mikan.host.assistant"))
		assertTrue(assistant in followedTeams(state))
	}

	@Test
	fun theOpenConversationFollowsAMoveAndLeavesOnlyOnItsGatewaysRelease() {
		val open = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
		val placed = placedOn("sakura", "mikan")
		val moved = "dom.mikan.host.assistant"

		assertEquals(moved, open.followAssistant(AssistantRoot.Placed(moved), placed).conversation?.team)

		val released = open.followAssistant(AssistantRoot.Loading, placed.withWord("sakura", holdsNone))
		assertNull(released.conversation)
		assertEquals(RootView.ASSISTANT, released.root)

		assertEquals(open, open.followAssistant(AssistantRoot.Unavailable(canPlace = true), placed.withWord("sakura", AssistantWord.Refused)))
		assertEquals(open, open.followAssistant(AssistantRoot.Loading, placed.withWord("sakura", null)))

		val aSession = ShellNav().arriveAt(session, false, Arrival.OUTSIDE, facts(session))
		assertEquals(aSession, aSession.followAssistant(AssistantRoot.Placed(moved), placed))
	}

	@Test
	fun onlyAnAnswerOrTheRosterReadsAsARelease() {
		val placed = placedOn("sakura")
		val revoked = { provenance: RegistryProvenance ->
			placed.copy(gateways = placed.gateways.copy(provenance = provenance, gateways = emptyList()))
		}

		assertTrue(assistantReleased(placed.withWord("sakura", holdsNone), "sakura"))
		assertTrue(assistantReleased(revoked(RegistryProvenance.Current), "sakura"))
		assertFalse(assistantReleased(placed, "sakura"))
		assertFalse(assistantReleased(placed.withWord("sakura", null), "sakura"))
		assertFalse(assistantReleased(placed.withWord("sakura", AssistantWord.Refused), "sakura"))
		assertFalse(assistantReleased(revoked(RegistryProvenance.Cached), "sakura"))
	}

	@Test
	fun aThreadFoundToBeTheAssistantsLeavesTheTabs() {
		val state = placedOn("sakura").copy(openTabs = listOf(session, assistant))

		assertEquals(listOf(session), state.withoutAssistantTabs().openTabs)
	}

	@Test
	fun aReachableHomeWinsOverAnOfflineOne() {
		val both = placedOn("alpha", "zulu").let { s ->
			s.copy(
				gateways = s.gateways.copy(
					gateways = s.gateways.gateways.map {
						it.copy(
							connected = it.id == "zulu",
							assistant = AssistantWord.Answered(
								ConsoleAssistantStateResult(workdir = "~/notes", team = "host.assistant", watchers = emptyList()),
							),
						)
					},
				),
			)
		}

		assertEquals(AssistantRoot.Placed("dom.zulu.host.assistant"), assistantRoot(both, null))
	}

	@Test
	fun settingsStayOverAMoveAndBackLandsOnTheRetargetedConversation() {
		val rules = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.openAssistantPage(AssistantPage.Rules("sakura", "github"))
		val moved = placedOn("mikan", "sakura").withWord("sakura", holdsNone)
		val mikan = "dom.mikan.host.assistant"

		val after = rules.followAssistant(assistantRoot(moved, "mikan"), moved).resolvePage(moved)

		assertEquals(AssistantPage.Settings, after.assistantPage)
		assertEquals(mikan, after.conversation?.team)
		val back = after.back(BackLayer.ASSISTANT_PAGE, backFacts(after), provisioned = true)
		assertNull(back.assistantPage)
		assertEquals(mikan, back.conversation?.team)
	}

	@Test
	fun settingsStayOverAReleaseAndBackLandsOnTheRoot() {
		val editor = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.openAssistantPage(AssistantPage.Editor("sakura", "github", RuleSlot.New))
		val released = placedOn("sakura").withWord("sakura", holdsNone)

		val after = editor.followAssistant(assistantRoot(released, null), released).resolvePage(released)
		val back = after.back(BackLayer.ASSISTANT_PAGE, backFacts(after), provisioned = true)

		assertEquals(AssistantPage.Settings, after.assistantPage)
		assertEquals(ShellScreen.ROOT, shellScreen(back, locked = false, overlayOpen = false, booted = true))
		assertEquals(RootView.ASSISTANT, back.root)
	}

	@Test
	fun aWatcherPageStaysWhileItsGatewayIsUnansweredAndUnwindsWhenTheWatcherIsGone() {
		val rules = AssistantPage.Rules("sakura", "github")
		val placed = placedOn("sakura")
		val noWatcher = placed.withWord(
			"sakura",
			AssistantWord.Answered(ConsoleAssistantStateResult(workdir = "~/notes", team = "host.assistant", watchers = emptyList())),
		)

		assertEquals(rules, rules.resolved(placed))
		assertEquals(rules, rules.resolved(placed.withWord("sakura", null)))
		assertEquals(rules, rules.resolved(placed.withWord("sakura", AssistantWord.Refused)))
		assertEquals(AssistantPage.Settings, rules.resolved(noWatcher))

		val editor = AssistantPage.Editor("sakura", "github", RuleSlot.New)
		for (older in listOf(github.copy(fields = null), github.copy(rules = null))) {
			val answer = ConsoleAssistantStateResult(workdir = "~/notes", team = "host.assistant", watchers = listOf(older))
			val olderGateway = placed.withWord("sakura", AssistantWord.Answered(answer))
			assertEquals(listOf(AssistantPage.Settings, AssistantPage.Settings), listOf(rules, editor).map { it.resolved(olderGateway) })
		}
	}

	@Test
	fun placingFromConfigureEntersBeneathTheSettingsPage() {
		val configuring = ShellNav(root = RootView.ASSISTANT).openAssistantPage(AssistantPage.Settings)

		val entered = configuring.enterAssistant(AssistantRoot.Placed(assistant), facts)

		assertEquals(assistant, entered.conversation?.team)
		assertEquals(AssistantPage.Settings, entered.assistantPage)
	}

	@Test
	fun entryWaitsWhileSettingsIsOpen() {
		val inSettings = ShellNav(root = RootView.ASSISTANT).openSettings()

		assertEquals(inSettings, inSettings.enterAssistant(AssistantRoot.Placed(assistant), facts))
	}

	@Test
	fun theAssistantRootEntersOnceWithoutBouncingBackIn() {
		val root = ShellNav(root = RootView.ASSISTANT)
		val entered = root.enterAssistant(AssistantRoot.Placed(assistant), facts)
		assertEquals(assistant, entered.conversation?.team)

		val left = entered.back(BackLayer.CONVERSATION, backFacts(entered), provisioned = true)
		assertEquals(left, left.enterAssistant(AssistantRoot.Placed(assistant), facts))
	}

	@Test
	fun theAssistantShowsItsTitleChipsAndGearWithNoTabs() {
		val watcher = com.atelier_nyaarium.switchboard.proto.AssistantWatcher(id = "github", label = "GitHub", grants = emptyList(), unread = 0L)
		val tabs = listOf(session, "dom.mikan.app.dev")
		val chrome = threadChrome(assistant = true, label = "assistant", tabs = tabs, watchers = listOf(watcher))
		val sessionChrome = threadChrome(assistant = false, label = "dev", tabs = tabs, watchers = listOf(watcher))

		assertEquals(Triple("Assistant", false, false), Triple(chrome.title, chrome.tabRow, chrome.sessionMenu))
		assertEquals(listOf(watcherChip(watcher)), chrome.chips)
		assertEquals(Triple("dev", true, true), Triple(sessionChrome.title, sessionChrome.tabRow, sessionChrome.sessionMenu))
		assertEquals(emptyList<WatcherChip>(), sessionChrome.chips)
	}
}
