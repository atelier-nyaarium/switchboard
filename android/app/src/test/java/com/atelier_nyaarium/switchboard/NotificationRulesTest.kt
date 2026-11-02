package com.atelier_nyaarium.switchboard

import android.app.Notification
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationRulesTest {
	private val zone = ZoneId.of("America/Los_Angeles")

	@Test
	fun selectsNewestFirstAndCapsTheResult() {
		val entries = (0 until 35).map { entry(it.toString(), postedAt = it.toLong()) }

		assertEquals((34 downTo 5).map { it.toString() }, selectNotifications(entries, null, 40).map { it.key })
		assertEquals((34 downTo 25).map { it.toString() }, selectNotifications(entries, null, null).map { it.key })
	}

	@Test
	fun filtersByAppThroughTheSharedMatch() {
		val mail = entry("mail", appLabel = "Mail Client", packageName = "org.example.mail")
		val chat = entry("chat", appLabel = "Chat", packageName = "org.example.chat")

		assertEquals(listOf(mail), selectNotifications(listOf(mail, chat), "example.MAIL", null))
		assertEquals(listOf(chat, mail), selectNotifications(listOf(mail, chat), "  ", null).sortedBy { it.key })
	}

	@Test
	fun dismissedEntriesRemainListedWithoutReplyability() {
		val dismissed = entry("dismissed", showing = false)
		val wire = notificationOf(dismissed, zone)

		assertEquals(listOf(dismissed), selectNotifications(listOf(dismissed), null, null))
		assertFalse(wire.replyable)
		assertEquals("1969-12-31T16:00:00-08:00", wire.postedAt)
	}

	@Test
	fun excludesOwnSummariesAndOngoingNotifications() {
		assertFalse(keepsNotification("own.app", "own.app", 0))
		assertFalse(keepsNotification("other.app", "own.app", Notification.FLAG_GROUP_SUMMARY))
		assertFalse(keepsNotification("other.app", "own.app", Notification.FLAG_ONGOING_EVENT))
		assertTrue(keepsNotification("other.app", "own.app", 0))
	}

	@Test
	fun textTrimsCapsAndUsesBigTextAsFallback() {
		val (title, text) = notificationTextOf(
			mapOf(
				Notification.EXTRA_TITLE to "  Title  ",
				Notification.EXTRA_TEXT to "  ",
				Notification.EXTRA_BIG_TEXT to "  Expanded  ",
			),
		)
		val (_, capped) = notificationTextOf(mapOf(Notification.EXTRA_TEXT to "x".repeat(510)))

		assertEquals("Title", title)
		assertEquals("Expanded", text)
		assertEquals(500, capped?.length)
	}

	@Test
	fun replyRequestsStayWithinWireBounds() {
		assertTrue(validReplyRequest("n1", "reply"))
		assertFalse(validReplyRequest("", "reply"))
		assertFalse(validReplyRequest("n1", ""))
		assertFalse(validReplyRequest("n".repeat(121), "reply"))
		assertFalse(validReplyRequest("n1", "x".repeat(1001)))
	}

	@Test
	fun wireFieldsStayWithinTheirDeclaredBounds() {
		val source = entry(
			key = "i".repeat(130),
			appLabel = "a".repeat(90),
			packageName = "p".repeat(130),
			title = "t".repeat(210),
			text = "x".repeat(510),
		)
		val wire = notificationOf(source, zone)

		assertEquals(120, wire.id.length)
		assertEquals(80, wire.app.length)
		assertEquals(120, wire.`package`.length)
		assertEquals(200, wire.title?.length)
		assertEquals(500, wire.text?.length)
	}

	private fun entry(
		key: String,
		appLabel: String = "App",
		packageName: String = "com.example.app",
		title: String? = null,
		text: String? = null,
		postedAt: Long = 0L,
		showing: Boolean = true,
	) = NotificationEntry(key, packageName, appLabel, title, text, postedAt, showing, null)
}
