package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
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

	private fun homeAt(gatewayId: String, vararg others: String) = ChatState(
		domainId = "dom",
		assistantHome = AssistantHome.Read(
			AssistantHomeRecord(version = 1L, gatewayId = gatewayId),
			AssistantHomeReport(version = 1L, gatewayId = gatewayId, outcome = "placed"),
		),
		gateways = testRegistry(gatewayId, *others),
	)

	private fun placedOn(gatewayId: String, vararg others: String) =
		homeAt(gatewayId, *others).withWord(
			gatewayId,
			AssistantWord.Answered(ConsoleAssistantStateResult(workdir = "~/notes", team = "host.assistant", watchers = listOf(github))),
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
	fun theLandingFoldReadsTheHomeRecordAndCurrentReport() {
		val unread = ChatState(domainId = "dom", gateways = testRegistry("sakura"))
		assertEquals(AssistantRoot.Loading, assistantRoot(unread))
		assertEquals(AssistantRoot.RouterUnreachable, assistantRoot(unread.copy(connected = false, error = "offline")))
		assertEquals(AssistantRoot.SetUp, assistantRoot(unread.copy(assistantHome = AssistantHome.Read(null, null))))
		assertEquals(
			AssistantRoot.SetUp,
			assistantRoot(unread.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, null), null))),
		)

		val moving = homeAt("sakura").copy(
			assistantHome = AssistantHome.Read(AssistantHomeRecord(2L, "sakura"), null),
		)
		assertEquals(AssistantRoot.Moving("sakura"), assistantRoot(moving))
		assertEquals(AssistantRoot.Moving("sakura"), assistantRoot(moving.copy(
			assistantHome = AssistantHome.Read(
				AssistantHomeRecord(2L, "sakura"),
				AssistantHomeReport(1L, "sakura", "placed"),
			),
		)))
		assertEquals(AssistantRoot.Moving("sakura"), assistantRoot(moving.copy(
			assistantHome = AssistantHome.Read(
				AssistantHomeRecord(2L, "sakura"),
				AssistantHomeReport(2L, "mikan", "placed"),
			),
		)))

		val refused = moving.copy(assistantHome = AssistantHome.Read(
			AssistantHomeRecord(2L, "sakura"),
			AssistantHomeReport(2L, "sakura", "refused", "key unavailable"),
		))
		assertEquals(AssistantRoot.Failed("key unavailable"), assistantRoot(refused))
		assertEquals(AssistantRoot.Failed("put failed"), assistantRoot(moving, "put failed"))

		val offline = homeAt("sakura").copy(
			gateways = testRegistry("sakura").copy(
				gateways = testRegistry("sakura").gateways.map { it.copy(connected = false) },
			),
		)
		assertEquals(AssistantRoot.HomeUnreachable("sakura"), assistantRoot(offline))
		assertEquals(AssistantRoot.Placed(assistant), assistantRoot(placedOn("sakura", "mikan")))

		// A stuck landing still reaches Settings.
		assertEquals(
			listOf(false, false, true, true),
			listOf(unread, unread.copy(connected = false, error = "offline"), offline, moving).map { rootOffersSettings(assistantRoot(it)) },
		)
	}

	@Test
	fun openingATabRefusesTheAssistant() {
		val state = placedOn("sakura").copy(openTabs = listOf(session))

		assertNull(tabsAfterOpen(state, assistant))
		assertEquals(listOf(session), tabsAfterOpen(state, session))
		assertEquals(listOf(session, "dom.sakura.app.web"), tabsAfterOpen(state, "dom.sakura.app.web"))
	}

	@Test
	fun identityUsesRoleStampsPersistedRolesAndTheHomeAddress() {
		val stamped = "dom.sakura.host.old"
		val persisted = "dom.mikan.host.old"
		val state = homeAt("sakura").copy(
			teams = listOf(Team(stamped, Presence.ended(), role = ASSISTANT_ROLE)),
			roles = mapOf(persisted to ASSISTANT_ROLE),
		)

		assertTrue(isAssistant(state, stamped))
		assertTrue(isAssistant(state, persisted))
		assertTrue(isAssistant(state, assistant))
		assertFalse(isAssistant(state, "dom.yuzu.host.assistant"))
		assertEquals(setOf(stamped, persisted, assistant), assistantTeams(state))
	}

	@Test
	fun theOpenConversationFollowsTheRouterHomeAndLeavesWhenItMovesElsewhere() {
		val open = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
		val placed = homeAt("mikan", "sakura")
		val moved = "dom.mikan.host.assistant"

		assertEquals(moved, open.followAssistant(assistantRoot(placed), placed).conversation?.team)

		val elsewhere = open.followAssistant(AssistantRoot.HomeUnreachable("sakura"), placed)
		assertNull(elsewhere.conversation)
		assertEquals(RootView.ASSISTANT, elsewhere.root)

		// An unreachable home it still names keeps the thread.
		assertEquals(open, open.followAssistant(AssistantRoot.HomeUnreachable("sakura"), homeAt("sakura")))

		val refused = homeAt("sakura").copy(
			assistantHome = AssistantHome.Read(
				AssistantHomeRecord(2L, "sakura"),
				AssistantHomeReport(2L, "sakura", "refused", "bad folder"),
			),
		)
		val failed = assistantRoot(refused)
		assertEquals(AssistantRoot.Failed("bad folder"), failed)
		assertNull(open.followAssistant(failed, refused).conversation)
		assertEquals(open, open.followAssistant(AssistantRoot.Failed("put failed"), homeAt("sakura")))

		val nobody = placed.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(2L, null), null))
		val left = open.followAssistant(AssistantRoot.SetUp, nobody)
		assertNull(left.conversation)
		assertEquals(RootView.ASSISTANT, left.root)

		val aSession = ShellNav().arriveAt(session, false, Arrival.OUTSIDE, facts(session))
		assertEquals(aSession, aSession.followAssistant(AssistantRoot.Placed(moved), placed))
	}

	@Test
	fun aThreadFoundToBeTheAssistantsLeavesTheTabs() {
		val state = placedOn("sakura").copy(openTabs = listOf(session, assistant))

		assertEquals(listOf(session), state.withoutAssistantTabs().openTabs)
	}

	@Test
	fun assistantLeftUsesOnlyAReadRecord() {
		assertFalse(assistantLeft(ChatState(), "sakura"))
		assertFalse(assistantLeft(homeAt("sakura"), "sakura"))
		assertTrue(assistantLeft(homeAt("mikan"), "sakura"))
		assertTrue(assistantLeft(homeAt("sakura").copy(
			assistantHome = AssistantHome.Read(AssistantHomeRecord(2L, null), null),
		), "sakura"))
	}

	@Test
	fun settingsStayOverAMoveAndBackLandsOnTheRetargetedConversation() {
		val rules = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.openAssistantPage(AssistantPage.Rules("sakura", "github"))
		val moved = placedOn("mikan", "sakura").withWord("sakura", holdsNone)
		val mikan = "dom.mikan.host.assistant"

		val after = rules.followAssistant(assistantRoot(moved), moved).resolvePage(moved)

		assertEquals(AssistantPage.Settings, after.assistantPage)
		assertEquals(mikan, after.conversation?.team)
		val back = after.back(BackLayer.ASSISTANT_PAGE, backFacts(after), provisioned = true)
		assertNull(back.assistantPage)
		assertEquals(mikan, back.conversation?.team)
	}

	@Test
	fun settingsStayOverRemoveAndBackLandsOnTheRoot() {
		val editor = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.openAssistantPage(AssistantPage.Editor("sakura", "github", RuleSlot.New))
		val removed = homeAt("sakura").copy(
			assistantHome = AssistantHome.Read(AssistantHomeRecord(2L, null), null),
		)

		val after = editor.followAssistant(assistantRoot(removed), removed).resolvePage(removed)
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
		assertEquals(AssistantPage.Settings, rules.resolved(placedOn("mikan", "sakura")))

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
