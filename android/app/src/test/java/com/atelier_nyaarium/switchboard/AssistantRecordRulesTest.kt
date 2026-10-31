package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantRecordThread
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantRecordRulesTest {
	private fun entry(kind: String = ASSISTANT_RECORD_KIND, notify: Boolean? = false, threads: List<AssistantRecordThread>?) =
		MailboxEntry(seq = 1L, at = 1L, kind = kind, session_id = "conv", notify = notify, threads = threads)

	private val done = AssistantRecordThread(threadId = "1", title = "v2", url = "https://github.com/a/b", outcome = "done")
	private val bare = AssistantRecordThread(threadId = "2", url = "http://github.com/a/b", outcome = "something_new")

	@Test
	fun aRecordComesOnlyFromItsKindWithThreadsAndStaysQuietUnlessToldToNotify() {
		val quiet = recordOf(entry(notify = null, threads = listOf(done)))
		val loud = recordOf(entry(notify = true, threads = listOf(done)))

		assertNull(recordOf(entry(kind = "notice", threads = listOf(done))))
		assertNull(recordOf(entry(threads = emptyList())))
		assertTrue(Message(false, "", 1L, record = quiet).isQuiet())
		assertFalse(Message(false, "Worth a look.", 1L, record = loud).isQuiet())
		assertFalse(Message(false, "hi", 1L).isQuiet())
	}

	@Test
	fun peerRowsDrainedBeforeTheAssistantWasKnownGoQuietOnceItIs() {
		val assistant = "local.gw.host.assistant"
		val other = "local.gw.host.worker"
		val peer = Message(false, "sent on", 1L, seq = 1L, isPeer = true)
		val reply = Message(false, "to the owner", 2L, seq = 2L, title = "Done")
		val loud = ChatState(threads = mapOf(assistant to listOf(peer, reply), other to listOf(peer)))
		val known = loud.copy(roles = mapOf(assistant to ASSISTANT_ROLE))

		val quieted = known.withAssistantPeersQuiet()

		assertTrue(loud.withAssistantPeersQuiet() === loud)
		assertEquals(listOf(true, false), quieted.threads.getValue(assistant).map { it.quiet })
		assertEquals(listOf(false), quieted.threads.getValue(other).map { it.quiet })
		assertEquals(1, quieted.unread[assistant])
		assertTrue(quieted.withAssistantPeersQuiet() === quieted)
	}

	@Test
	fun onlyPeerRowsInTheAssistantsConversationGoQuiet() {
		val peer = Message(false, "sent on", 1L, isPeer = true)
		val reply = Message(false, "to the owner", 2L)

		assertEquals(
			listOf(true, false, false),
			listOf(
				quietInConversation(assistant = true, peer),
				quietInConversation(assistant = true, reply),
				quietInConversation(assistant = false, peer),
			),
		)
	}

	@Test
	fun thePageDrawsFixedTextAndOpensOnlyAnHttpsLink() {
		val view = recordView(recordOf(entry(threads = listOf(done, bare)))!!)
		val items = view.getJSONArray("items")

		assertEquals(true, view.getBoolean("quiet"))
		assertEquals("2 cleared quietly", view.getString("line"))
		assertEquals(listOf("v2", "2"), (0 until items.length()).map { items.getJSONObject(it).getString("label") })
		assertEquals("https://github.com/a/b", items.getJSONObject(0).optString("href"))
		assertFalse(items.getJSONObject(1).has("href"))
		assertEquals(listOf("Done", "Unknown"), (0 until items.length()).map { items.getJSONObject(it).getString("outcome") })
	}

	@Test
	fun aStoredThreadMissingItsIdIsDroppedOnLoad() {
		val record = recordOf(entry(notify = true, threads = listOf(done, bare)))!!
		val stored = recordJson(record)
		stored.getJSONArray("threads").put(org.json.JSONObject().put("outcome", "done"))

		assertEquals(record, loadRecord(stored))
	}

	@Test
	fun phoneActOutcomesHaveOwnerLabels() {
		assertEquals("Ran", outcomeLabel("ran"))
		assertEquals("Unavailable", outcomeLabel("unavailable"))
		assertEquals("Refused", outcomeLabel("refused"))
	}
}
