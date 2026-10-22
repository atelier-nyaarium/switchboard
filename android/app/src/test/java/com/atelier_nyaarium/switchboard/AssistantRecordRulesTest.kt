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
		assertTrue(Message(false, "", 1L, record = quiet).isQuietRecord())
		assertFalse(Message(false, "Worth a look.", 1L, record = loud).isQuietRecord())
		assertFalse(Message(false, "hi", 1L).isQuietRecord())
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
}
