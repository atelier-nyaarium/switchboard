package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NoticesTest {
	private val team = "local.gw.host.one"

	@Test
	fun aKeyedNoticeReplacesItsKeyAndASuccessClearsIt() {
		val raised = ChatState()
			.withNotice("Waking failed.", key = "wake:a", team = team)
			.withNotice("Unrelated.")
			.withNotice("Waking failed again.", key = "wake:a", team = team)

		assertEquals(listOf("Unrelated.", "Waking failed again."), raised.notices.map { it.text })
		assertEquals(listOf("Unrelated."), raised.withoutNoticeKey("wake:a").notices.map { it.text })
	}

	@Test
	fun aPromptThePhoneCouldNotShowIsToldOnceAndOnlyAShownPassClearsIt() = runBlocking {
		val state = MutableStateFlow(ChatState())
		// Null: nothing was asked.
		val all = listOf(OwnerPrompt.COULD_NOT_ASK, OwnerPrompt.COULD_NOT_ASK, OwnerPrompt.REFUSED, OwnerPrompt.NO_SCREEN_LOCK, null, OwnerPrompt.PASSED)

		val told = all.map { answer -> state.asked { answer } to state.value.notices.size }

		assertEquals(listOf(false to 1, false to 1, false to 1, true to 1, true to 1, true to 0), told)
		assertEquals(OwnerPrompt.COULD_NOT_ASK, requireOwnerPresent(null))
	}

	@Test
	fun onlyAPhoneWithNoScreenLockPassesUnaskedAndOnlyBackingOutIsARefusal() {
		val statuses = listOf(
			androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS,
			androidx.biometric.BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED,
			androidx.biometric.BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE,
			androidx.biometric.BiometricManager.BIOMETRIC_STATUS_UNKNOWN,
		)
		val errors = listOf(
			androidx.biometric.BiometricPrompt.ERROR_USER_CANCELED,
			androidx.biometric.BiometricPrompt.ERROR_NEGATIVE_BUTTON,
			androidx.biometric.BiometricPrompt.ERROR_CANCELED,
			androidx.biometric.BiometricPrompt.ERROR_TIMEOUT,
			androidx.biometric.BiometricPrompt.ERROR_HW_UNAVAILABLE,
			androidx.biometric.BiometricPrompt.ERROR_LOCKOUT,
		)

		assertEquals(
			listOf(null, OwnerPrompt.COULD_NOT_ASK, OwnerPrompt.COULD_NOT_ASK, OwnerPrompt.COULD_NOT_ASK),
			statuses.map { promptWithout(secure = true, it) },
		)
		assertEquals(List(4) { OwnerPrompt.NO_SCREEN_LOCK }, statuses.map { promptWithout(secure = false, it) })
		assertEquals(
			List(4) { OwnerPrompt.REFUSED } + List(2) { OwnerPrompt.COULD_NOT_ASK },
			errors.map(::promptError),
		)
		assertEquals(
			listOf(true, false, true, false),
			listOf(OwnerPrompt.PASSED, OwnerPrompt.REFUSED, OwnerPrompt.NO_SCREEN_LOCK, OwnerPrompt.COULD_NOT_ASK).map(::passes),
		)
	}

	@Test
	fun onlyAPassUnlocksAndAFaultShowsUntilTheLockMoves() {
		fun stands() = AppLock.unlocked.value to AppLock.fault.value
		AppLock.relock()
		try {
			AppLock.answered(OwnerPrompt.REFUSED)
			assertEquals(false to false, stands())
			AppLock.answered(OwnerPrompt.COULD_NOT_ASK)
			assertEquals(false to true, stands())
			AppLock.relock()
			assertEquals(false to false, stands())

			AppLock.answered(OwnerPrompt.COULD_NOT_ASK)
			AppLock.answered(OwnerPrompt.NO_SCREEN_LOCK)
			assertEquals(true to false, stands())
			AppLock.relock()
			AppLock.answered(OwnerPrompt.PASSED)
			assertEquals(true to false, stands())
		} finally {
			AppLock.relock()
		}
	}

	@Test
	fun theSameUnkeyedLineRaisedAgainIsHeldOnce() {
		val held = ChatState().withNotice("Same.").withNotice("Same.", team = team).withNotice("Same.")

		assertEquals(listOf(team, null), held.notices.map { it.team })
	}

	@Test
	fun theCapDropsTheOldestAndIdsStayDistinct() {
		val held = (1..7).fold(ChatState()) { s, n -> s.withNotice("n$n") }

		assertEquals((3..7).map { "n$it" }, held.notices.map { it.text })
		assertEquals(NOTICES_MAX, held.notices.map { it.id }.toSet().size)
	}

	@Test
	fun theXRemovesOneAndClearAllShowsPastTwo() {
		val held = ChatState().withNotice("a").withNotice("b").withNotice("c")

		assertEquals(listOf("a", "c"), held.withoutNotice(held.notices[1].id).notices.map { it.text })
		assertFalse(showsClearAll(2))
		assertTrue(showsClearAll(3))
	}

	@Test
	fun aConversationsNoticeIsPrefixedOnlyElsewhere() {
		val held = ChatState().withNotice("Rename failed.", team = team).withNotice("Global.").notices
		val label = { t: String -> if (t == team) "One" else t }

		assertEquals(listOf("Rename failed.", "Global."), noticeLines(held, team, label).map { it.text })
		assertEquals(listOf("One: Rename failed.", "Global."), noticeLines(held, null, label).map { it.text })
	}

	@Test
	fun theThreadHostsOnlyItsChatWithNoEditor() {
		val chat = Drawn.Conversation(team, ConversationView.CHAT, emptyList(), assistant = false, openNonce = 0)

		assertEquals(NoticeHost.THREAD, noticeHost(chat, editorShown = false))
		assertEquals(NoticeHost.SHELL, noticeHost(chat, editorShown = true))
		assertEquals(NoticeHost.SHELL, noticeHost(chat.copy(view = ConversationView.TERMINAL), editorShown = false))
		assertEquals(NoticeHost.SHELL, noticeHost(Drawn.Root(RootView.SESSIONS, null), editorShown = false))
		assertEquals(NoticeHost.NONE, noticeHost(Drawn.Lock, editorShown = false))
	}

	@Test
	fun theShellStripHoldsLinesOnlyWhereTheShellHosts() {
		val held = ChatState().withNotice("Global.").notices
		val chat = Drawn.Conversation(team, ConversationView.CHAT, emptyList(), assistant = false, openNonce = 0)

		assertEquals(listOf("Global."), shellNoticeLines(held, noticeAt(Drawn.Root(RootView.SESSIONS, null), false)) { it }.map { it.text })
		assertEquals(emptyList<NoticeLine>(), shellNoticeLines(held, noticeAt(chat, false)) { it })
		assertEquals(emptyList<NoticeLine>(), shellNoticeLines(held, noticeAt(Drawn.Lock, false)) { it })
	}
}
