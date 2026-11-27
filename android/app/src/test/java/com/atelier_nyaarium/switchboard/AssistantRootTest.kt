package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
import com.atelier_nyaarium.switchboard.proto.AssistantSource
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
			offered = conversationViews(terminal = true, assistant = team == assistant),
			stuckAtLogin = false,
		)
	}

	private fun shellFacts(nav: ShellNav) = ShellFacts(
		editorOpen = false,
		locked = false,
		overlayOpen = false,
		booted = true,
		drawerOpen = false,
		offeredRoot = rootViews(DrawerFeatures(true, true)),
		offeredConversation = nav.heldTeam?.let { facts(it).offered }.orEmpty(),
		assistantOpen = nav.heldTeam == assistant,
	)

	private fun drawn(nav: ShellNav) = nav.drawn(shellFacts(nav))

	/** The stack, top first. */
	private fun pagesOf(nav: ShellNav): List<ShellPage> =
		generateSequence(nav) { if (drawn(it) is Drawn.Page) it.pop() else null }.mapNotNull { (drawn(it) as? Drawn.Page)?.page }.toList()

	private val github = AssistantSource(
		id = "github",
		label = "GitHub",
		grants = emptyList(),
		unread = 0L,
		fieldSpecs = emptyList(),
		actions = emptyList(),
		enabled = true,
		triggers = true,
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
			AssistantRead.Answered(assistantState(workdir = "~/notes", team = "host.assistant", sources = listOf(github))),
		)

	private val holdsNone = AssistantRead.Answered(assistantState())

	private fun ChatState.withWord(gatewayId: String, word: AssistantRead?) =
		copy(gateways = gateways.withEntry(gatewayId) { it.copy(assistant = word ?: AssistantRead.Reading) })

	@Test
	fun theAssistantArrivesUnderItsRootAndBackStepsTerminalChatSessions() {
		val inTerminal = ShellNav().showRoot(RootView.ROUTINES)
			.arriveAt(assistant, assistant = true, Arrival.FILES_ASKED, facts(assistant), WorkspacePlace.Windows)
			.showView(ConversationView.TERMINAL)

		assertEquals(Drawn.Root(RootView.ASSISTANT, null), drawn(inTerminal.leave()))
		assertEquals(listOf(WORKSPACE_ROOT), (drawn(inTerminal) as Drawn.Conversation).files)

		val inChat = inTerminal.up(shellFacts(inTerminal))
		assertEquals(ConversationView.CHAT, (drawn(inChat) as Drawn.Conversation).view)

		val left = inChat.back(backLayer(inChat, shellFacts(inChat))!!, shellFacts(inChat), provisioned = true)
		assertEquals(Drawn.Root(RootView.SESSIONS, null), drawn(left))
		assertEquals(left, inChat.up(shellFacts(inChat)))
	}

	@Test
	fun aSessionArrivingOverTheAssistantReturnsToSessionsAndBackLeavesAtOnce() {
		val nav = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.arriveAt(session, false, Arrival.OUTSIDE, facts(session))
			.showView(ConversationView.TERMINAL)

		assertEquals(Drawn.Root(RootView.SESSIONS, null), drawn(nav.leave()))
		assertNull(nav.up(shellFacts(nav)).heldTeam)
	}

	@Test
	fun theAssistantIsOfferedChatAndTerminalAlone() {
		assertEquals(listOf(ConversationView.CHAT, ConversationView.TERMINAL), conversationViews(terminal = true, assistant = true))
		assertEquals(listOf(ConversationView.CHAT), conversationViews(terminal = false, assistant = true))
	}

	@Test
	fun theLandingFoldReadsTheHomeRecordAndCurrentReport() {
		val unread = ChatState(domainId = "dom", gateways = testRegistry("sakura"))
		assertEquals(AssistantRoot.Loading, assistantRoot(unread))
		val unreached = unread.copy(router = linkAfter(RouterEvent.Missed(Miss.UNREACHABLE)))
		assertEquals(AssistantRoot.RouterUnreachable, assistantRoot(unreached))
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
		assertEquals(AssistantRoot.Failed("put failed"), assistantRoot(moving.copy(homeFailure = "put failed")))

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
			listOf(unread, unreached, offline, moving).map { rootOffersSettings(assistantRoot(it)) },
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

		assertEquals(moved, open.followAssistant(assistantRoot(placed), placed).heldTeam)

		val elsewhere = open.followAssistant(AssistantRoot.HomeUnreachable("sakura"), placed)
		assertEquals(Drawn.Root(RootView.ASSISTANT, null), drawn(elsewhere))

		// Named unreachable home keeps thread.
		assertEquals(open, open.followAssistant(AssistantRoot.HomeUnreachable("sakura"), homeAt("sakura")))

		val refused = homeAt("sakura").copy(
			assistantHome = AssistantHome.Read(
				AssistantHomeRecord(2L, "sakura"),
				AssistantHomeReport(2L, "sakura", "refused", "bad folder"),
			),
		)
		val failed = assistantRoot(refused)
		assertEquals(AssistantRoot.Failed("bad folder"), failed)
		assertNull(open.followAssistant(failed, refused).heldTeam)
		assertEquals(open, open.followAssistant(AssistantRoot.Failed("put failed"), homeAt("sakura")))

		val nobody = placed.copy(assistantHome = AssistantHome.Read(AssistantHomeRecord(2L, null), null))
		val left = open.followAssistant(AssistantRoot.SetUp, nobody)
		assertEquals(Drawn.Root(RootView.ASSISTANT, null), drawn(left))

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
	fun aSourcePageClosesOverAMoveOntoTheRetargetedConversation() {
		val rules = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.push(ShellPage.Source("sakura", "github"))
		val moved = placedOn("mikan", "sakura").withWord("sakura", holdsNone)

		val after = rules.followAssistant(assistantRoot(moved), moved).resolvePages(moved)

		assertEquals("dom.mikan.host.assistant", (drawn(after) as Drawn.Conversation).team)
	}

	@Test
	fun aPageClosesOverRemoveOntoTheRoot() {
		val editor = ShellNav().arriveAt(assistant, true, Arrival.OUTSIDE, facts(assistant))
			.push(ShellPage.Source("sakura", "github"))
		val removed = homeAt("sakura").copy(
			assistantHome = AssistantHome.Read(AssistantHomeRecord(2L, null), null),
		)

		val after = editor.followAssistant(assistantRoot(removed), removed).resolvePages(removed)

		assertEquals(Drawn.Root(RootView.ASSISTANT, null), drawn(after))
	}

	@Test
	fun resolvingPagesDropsTheGoneAndCollapsesAdjacentRepeats() {
		val entry = ShellPage.Entry("sakura", "kasa")
		val source = ShellPage.Source("sakura", "github")
		val stack = ShellNav().showRoot(RootView.SOURCES).push(ShellPage.Add).push(entry).push(source)
		val placed = placedOn("sakura")
		val unoffered = placed.withWord(
			"sakura",
			AssistantRead.Answered(assistantState(workdir = "~/notes", team = "host.assistant", offered = listOf("ifttt"))),
		)

		assertEquals(stack, stack.resolvePages(placed))
		assertEquals(listOf(ShellPage.Add), pagesOf(stack.resolvePages(unoffered)))
		assertEquals(listOf(ShellPage.Add), pagesOf(stack.resolvePages(placedOn("mikan", "sakura"))))
		assertEquals(listOf(source, entry, ShellPage.Add), pagesOf(stack))
	}

	@Test
	fun aViewOfTheHomesRecordsSaysWhetherTheHomeIsUnreadUnreachableOrNobody() {
		assertEquals(NoHome.READING, noHome(ChatState()))
		assertEquals(NoHome.NOT_PLACED, noHome(ChatState(assistantHome = AssistantHome.Read(AssistantHomeRecord(1L, null), null))))
	}

	@Test
	fun anEntryPageStaysWhileUnansweredAndUnwindsToAddOnceTheGatewayStopsOfferingIt() {
		val entry = ShellPage.Entry("sakura", "kasa")
		val placed = placedOn("sakura")
		val offersIfttt = placed.withWord(
			"sakura",
			AssistantRead.Answered(assistantState(workdir = "~/notes", team = "host.assistant", offered = listOf("ifttt"))),
		)

		assertEquals(entry, entry.resolved(placed))
		assertEquals(entry, entry.resolved(placed.withWord("sakura", null)))
		assertEquals(ShellPage.Add, entry.resolved(offersIfttt))
		assertEquals(ShellPage.Add, ShellPage.Entry("sakura", "zigbee").resolved(placed))
		assertNull(entry.resolved(placedOn("mikan", "sakura")))
	}

	@Test
	fun aSourcePageStaysWhileItsGatewayIsUnansweredAndUnwindsWhenTheSourceIsGone() {
		val source = ShellPage.Source("sakura", "github")
		val itsAutomations = ShellPage.SourceAutomations("sakura", "github")
		val placed = placedOn("sakura")
		val noSource = placed.withWord(
			"sakura",
			AssistantRead.Answered(assistantState(workdir = "~/notes", team = "host.assistant")),
		)

		assertEquals(source, source.resolved(placed))
		assertEquals(source, source.resolved(placed.withWord("sakura", null)))
		assertEquals(source, source.resolved(placed.withWord("sakura", AssistantRead.Refused)))
		assertNull(source.resolved(noSource))
		assertNull(source.resolved(placedOn("mikan", "sakura")))
		assertEquals(itsAutomations, itsAutomations.resolved(placed))
		assertNull(itsAutomations.resolved(noSource))
	}

	@Test
	fun placingFromConfigureEntersBeneathTheSettingsPage() {
		val configuring = ShellNav().showRoot(RootView.ASSISTANT).push(ShellPage.Settings)

		val entered = configuring.enterAssistant(AssistantRoot.Placed(assistant), facts)

		assertEquals(Drawn.Page(ShellPage.Settings, overAssistant = true), drawn(entered))
		assertEquals(assistant, (drawn(entered.pop()) as Drawn.Conversation).team)
	}

	@Test
	fun entryWaitsWhileSettingsIsOpen() {
		val inSettings = ShellNav().showRoot(RootView.ASSISTANT).openSettings()

		assertEquals(inSettings, inSettings.enterAssistant(AssistantRoot.Placed(assistant), facts))
	}

	@Test
	fun theAssistantRootEntersOnceWithoutBouncingBackIn() {
		val root = ShellNav().showRoot(RootView.ASSISTANT)
		val entered = root.enterAssistant(AssistantRoot.Placed(assistant), facts)
		assertEquals(assistant, entered.heldTeam)

		val left = entered.back(BackLayer.CONVERSATION, shellFacts(entered), provisioned = true)
		assertEquals(left, left.enterAssistant(AssistantRoot.Placed(assistant), facts))
	}

	@Test
	fun theAssistantShowsItsTitleInboxAndGearWithNoTabs() {
		val watcher = com.atelier_nyaarium.switchboard.proto.AssistantSource(
			id = "github",
			label = "GitHub",
			grants = listOf("gh-token"),
			unread = 3L,
			lastSuccessAt = 1L,
			fieldSpecs = emptyList(),
			actions = emptyList(),
			enabled = true,
			triggers = true,
		)
		val tabs = listOf(session, "dom.mikan.app.dev")
		val answered = AssistantRead.Answered(assistantState(sources = listOf(watcher)))
		val chrome = threadChrome(assistant = true, label = "assistant", tabs = tabs, home = answered)
		val sessionChrome = threadChrome(assistant = false, label = "dev", tabs = tabs, home = answered)

		assertEquals(Triple("Assistant", false, false), Triple(chrome.title, chrome.tabRow, chrome.sessionMenu))
		assertEquals(listOf(InboxRow.Waiting("github", "GitHub", "3 new")), chrome.inbox)
		assertEquals(Triple("dev", true, true), Triple(sessionChrome.title, sessionChrome.tabRow, sessionChrome.sessionMenu))
		assertEquals(emptyList<InboxRow>(), sessionChrome.inbox)
		assertEquals(emptyList<InboxRow>(), threadChrome(true, "assistant", tabs, AssistantRead.Reading).inbox)
	}
}
