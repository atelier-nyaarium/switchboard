package com.atelier_nyaarium.switchboard

import android.content.Intent
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantSummonTest {
	private val assistant = "dom.sakura.host.assistant"
	private val facts = { _: String -> ArrivalFacts(offered = assistantConversationViews(terminal = true), stuckAtLogin = false) }

	private fun answered(team: String?) = AssistantWord.Answered(
		ConsoleAssistantStateResult(workdir = team?.let { "~/notes" }, team = team, watchers = emptyList()),
	)

	private fun state(word: AssistantWord?) = ChatState(
		domainId = "dom",
		gateways = testRegistry("sakura").let { r -> r.withEntry("sakura") { it.copy(assistant = word) } },
	)

	private fun shown(
		nav: ShellNav,
		root: AssistantRoot,
		screen: ShellScreen = shellScreen(nav, false, false, true),
		composerShown: Boolean = true,
		covered: Boolean = false,
	) = summonShown(screen, nav, nav.conversation?.team == assistant, nav.conversation?.view, root, composerShown, covered)

	@Test
	fun aRestoredOrFromHistoryLaunchReplaysNothing() {
		assertTrue(isFreshSummon(Intent.ACTION_ASSIST, restored = false, flags = 0))
		assertFalse(isFreshSummon(Intent.ACTION_ASSIST, restored = true, flags = 0))
		assertFalse(isFreshSummon(Intent.ACTION_ASSIST, restored = false, flags = Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
		assertFalse(isFreshSummon(Intent.ACTION_MAIN, restored = false, flags = 0))
	}

	@Test
	fun aLockedSummonAsksOnceRetriesOnceAndArmsTheKeyboardOnlyOnSuccess() {
		val locked = summoned(1, keyguardShowing = true, deviceLocked = true)
		assertTrue(requestsDismissal(locked))
		assertFalse(requestsDismissal(summoned(2, keyguardShowing = false, deviceLocked = false)))

		val retry = locked.failed().retried(keyguardShowing = true, deviceLocked = true)!!
		assertTrue(requestsDismissal(retry))
		val gaveUp = retry.failed()
		assertEquals(Dismissal.CANCELLED, gaveUp.dismissal)
		assertEquals(SummonFocus.SPENT, gaveUp.focus)
		assertNull(gaveUp.retried(keyguardShowing = true, deviceLocked = true))

		val unlockedMeanwhile = locked.failed().retried(keyguardShowing = false, deviceLocked = false)!!
		assertFalse(requestsDismissal(unlockedMeanwhile))
		assertEquals(SummonFocus.SPENT, unlockedMeanwhile.focus)
		assertFalse(satisfiesAppLock(unlockedMeanwhile))

		val trustedMeanwhile = locked.failed().retried(keyguardShowing = true, deviceLocked = false)!!
		assertFalse(satisfiesAppLock(trustedMeanwhile.dismissed()))

		assertEquals(SummonFocus.ARMED, locked.dismissed().focus)
		assertEquals(SummonFocus.SPENT, locked.cancelled().focus)
	}

	@Test
	fun onlyAChallengedDismissalStandsForTheAppLockAndOnlyOnce() {
		val challenged = summoned(1, keyguardShowing = true, deviceLocked = true)
		assertTrue(promptsAppLock(locked = true, windowFocused = true, prompted = false, summon = null))
		assertFalse(promptsAppLock(locked = true, windowFocused = false, prompted = false, summon = null))
		assertFalse(promptsAppLock(locked = true, windowFocused = true, prompted = false, summon = challenged))

		val succeeded = challenged.dismissed()
		assertTrue(satisfiesAppLock(succeeded))
		assertFalse(promptsAppLock(locked = true, windowFocused = true, prompted = false, summon = succeeded))
		assertFalse(satisfiesAppLock(succeeded.lockTakenNow()))

		val smartLock = summoned(2, keyguardShowing = true, deviceLocked = false).dismissed()
		assertFalse(satisfiesAppLock(smartLock))
		assertTrue(promptsAppLock(locked = true, windowFocused = true, prompted = false, summon = smartLock))
	}

	@Test
	fun theResolverLandsPlacedUnplacedAndUnansweredSummons() {
		assertEquals(SummonLanding.At(assistant), summonLanding(state(answered("host.assistant")), assistantRoot(state(answered("host.assistant")), null), null))
		assertEquals(SummonLanding.Configure, summonLanding(state(answered(null)), AssistantRoot.Unplaced, null))

		val unread = state(null)
		assertEquals(SummonLanding.Root, summonLanding(unread, AssistantRoot.Loading, null))
		val past = "dom.mikan.host.assistant"
		val older = "dom.sakura.host.old"
		val remembered = unread.copy(
			roles = mapOf(older to ASSISTANT_ROLE, past to ASSISTANT_ROLE),
			threads = mapOf(older to listOf(Message(fromMe = true, text = "a", at = 2)), past to listOf(Message(fromMe = true, text = "b", at = 1))),
		)
		assertEquals(SummonLanding.At(older), summonLanding(remembered, AssistantRoot.Loading, null))
		assertEquals(SummonLanding.At(past), summonLanding(remembered, AssistantRoot.Unavailable(canPlace = false), "mikan"))

		val configure = ShellNav(root = RootView.SESSIONS).summonedTo(SummonLanding.Configure, facts)
		assertEquals(RootView.ASSISTANT, configure.root)
		assertEquals(AssistantPage.Settings, configure.assistantPage)
		assertEquals(ConversationView.CHAT, ShellNav().summonedTo(SummonLanding.At(assistant), facts).conversation?.view)
	}

	@Test
	fun aSummonIsHeldThroughBootAndFocusesTheComposerOnce() {
		val summon = summoned(1, keyguardShowing = true, deviceLocked = true)
		assertFalse(routesNow(summon, booted = false, resumed = true))
		assertFalse(routesNow(summon, booted = true, resumed = false))
		assertTrue(routesNow(summon, booted = true, resumed = true))
		assertEquals(FocusStep.WAIT, focusStep(summon, SummonShown.ELSEWHERE, windowFocused = true, resumed = true))

		val routed = summon.routedNow()
		assertFalse(routesNow(routed, booted = true, resumed = true))
		val nav = ShellNav().summonedTo(SummonLanding.At(assistant), facts)
		val chat = shown(nav, AssistantRoot.Placed(assistant))
		assertEquals(SummonShown.ASSISTANT_CHAT, chat)
		assertEquals(SummonShown.WAITING, shown(nav, AssistantRoot.Placed(assistant), ShellScreen.LOCK))

		assertEquals(FocusStep.WAIT, focusStep(routed, chat, windowFocused = true, resumed = true))
		val armed = routed.dismissed()
		assertEquals(FocusStep.WAIT, focusStep(armed, chat, windowFocused = false, resumed = true))
		assertEquals(FocusStep.IDLE, focusStep(armed, SummonShown.ELSEWHERE, windowFocused = true, resumed = false))
		assertEquals(FocusStep.FIRE, focusStep(armed, chat, windowFocused = true, resumed = true))
		assertEquals(FocusStep.IDLE, focusStep(armed.focusSpent(), chat, windowFocused = true, resumed = true))
	}

	@Test
	fun theKeyboardWaitsAtALoadingRootAndDropsAnywhereElse() {
		val armed = summoned(1, keyguardShowing = false, deviceLocked = false).routedNow()
		val atRoot = ShellNav().summonedTo(SummonLanding.Root, facts)
		assertEquals(FocusStep.WAIT, focusStep(armed, shown(atRoot, AssistantRoot.Loading), windowFocused = true, resumed = true))
		assertEquals(FocusStep.DROP, focusStep(armed, shown(atRoot, AssistantRoot.Unplaced), windowFocused = true, resumed = true))

		val chat = ShellNav().summonedTo(SummonLanding.At(assistant), facts)
		val scheduled = shown(chat, AssistantRoot.Placed(assistant), composerShown = false)
		assertEquals(FocusStep.DROP, focusStep(armed, scheduled, windowFocused = true, resumed = true))
		val underDrawer = shown(chat, AssistantRoot.Placed(assistant), covered = true)
		assertEquals(FocusStep.WAIT, focusStep(armed, underDrawer, windowFocused = true, resumed = true))
		val terminal = chat.showView(ConversationView.TERMINAL)
		assertEquals(FocusStep.DROP, focusStep(armed, shown(terminal, AssistantRoot.Placed(assistant)), windowFocused = true, resumed = true))
		assertEquals(FocusStep.DROP, focusStep(armed, shown(ShellNav(), AssistantRoot.Loading), windowFocused = true, resumed = true))
	}

	@Test
	fun aLockedSummonRetriesTakesTheLockRoutesAndFocusesOnceWhileAnOlderCallbackMovesNothing() {
		val older = SummonBus.raise(keyguardShowing = true, deviceLocked = true)
		val summon = SummonBus.raise(keyguardShowing = true, deviceLocked = true)
		val held = { SummonBus.pending.value }
		SummonBus.step(older.id, Summon::dismissed)
		assertFalse(satisfiesAppLock(held()))

		SummonBus.step(summon.id, Summon::failed)
		assertEquals(summon.id, SummonBus.retried(keyguardShowing = true, deviceLocked = true)?.id)
		assertNull(SummonBus.retried(keyguardShowing = true, deviceLocked = true))

		SummonBus.step(summon.id, Summon::dismissed)
		assertFalse(promptsAppLock(locked = true, windowFocused = true, prompted = false, summon = held()))
		assertTrue(satisfiesAppLock(held()))
		SummonBus.step(summon.id, Summon::lockTakenNow)
		assertFalse(satisfiesAppLock(held()))

		assertTrue(routesNow(held(), booted = true, resumed = true))
		SummonBus.step(summon.id, Summon::routedNow)
		assertFalse(routesNow(held(), booted = true, resumed = true))

		assertEquals(FocusStep.FIRE, focusStep(held(), SummonShown.ASSISTANT_CHAT, windowFocused = true, resumed = true))
		SummonBus.step(summon.id, Summon::focusSpent)
		assertEquals(FocusStep.IDLE, focusStep(held(), SummonShown.ASSISTANT_CHAT, windowFocused = true, resumed = true))
	}

	@Test
	fun aNewerOpenRequestSupersedesASummonNotYetLanded() {
		val pending = SummonBus.raise(keyguardShowing = false, deviceLocked = false)
		SummonBus.supersede()
		assertFalse(routesNow(SummonBus.pending.value, booted = true, resumed = true))
		assertEquals(FocusStep.IDLE, focusStep(SummonBus.pending.value, SummonShown.ASSISTANT_CHAT, windowFocused = true, resumed = true))

		val landedAwaitingKeyboard = summoned(pending.id + 1, keyguardShowing = false, deviceLocked = false).routedNow()
		val chat = SummonShown.ASSISTANT_CHAT
		assertEquals(FocusStep.FIRE, focusStep(landedAwaitingKeyboard, chat, windowFocused = true, resumed = true))
		assertEquals(FocusStep.IDLE, focusStep(landedAwaitingKeyboard.superseded(), chat, windowFocused = true, resumed = true))
	}
}
