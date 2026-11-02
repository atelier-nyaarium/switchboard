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

	private fun quiet(id: Long, at: Long = id, threads: List<String> = listOf("t$id")) =
		Message(false, "", at, id = id, record = ActionRecord(false, threads.map { RecordThread(it, null, null, "done") }))

	private fun said(id: Long) = Message(false, "said $id", id, id = id)

	private fun ids(rows: List<ThreadRow>) = rows.map { row -> row.messages.map { it.id } }

	private fun viewOf(row: List<Message>) = recordView(threadRows(row).single())

	private fun labels(view: org.json.JSONObject): List<String> {
		val items = view.getJSONArray("items")
		return (0 until items.length()).map { items.getJSONObject(it).getString("label") }
	}

	/** Mirrors thread.js landing. */
	private class Page {
		val drawn = mutableListOf<ThreadRow>()
		private var shown = emptyList<ThreadRow>()
		var rebuilds = 0

		fun show(thread: List<Message>) {
			val rows = threadRows(thread) { it.hashCode() }
			when (val delta = rowDelta(rows, shown)) {
				is RowDelta.Rebuild -> {
					rebuilds++
					drawn.clear()
					drawn += delta.rows
				}
				is RowDelta.Patch -> for (row in delta.appended + delta.changed) {
					val at = drawn.indexOfFirst { it.head.id == row.head.id }
					if (at >= 0) drawn[at] = row else drawn += row
				}
			}
			shown = rows
		}
	}

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
	fun consecutiveQuietRecordsShareOneRowAndAnythingElseEndsTheRun() {
		val peer = Message(false, "sent on", 6L, id = 6, isPeer = true, quiet = true)
		val loud = Message(false, "Worth a look.", 7L, id = 7, record = ActionRecord(true, listOf(RecordThread("t", null, null, "done"))))
		val thread = listOf(quiet(1), quiet(2), quiet(3), said(4), quiet(5), peer, loud, quiet(8))

		assertEquals(
			listOf(listOf(1L, 2L, 3L), listOf(4L), listOf(5L), listOf(6L), listOf(7L), listOf(8L)),
			ids(threadRows(thread)),
		)
		assertEquals(emptyList<ThreadRow>(), threadRows(emptyList()))
	}

	@Test
	fun aRunReadsAsOneLineSummedInOrderFromItsFirstMinuteToItsLast() {
		val first = quiet(1, 616 * 60_000L + 5_000, listOf("a", "b"))
		val sameMinute = quiet(2, 616 * 60_000L + 50_000, listOf("c"))
		val last = quiet(3, 744 * 60_000L, listOf("d"))
		val run = viewOf(listOf(first, sameMinute, last))

		assertEquals("4 cleared quietly", run.getString("line"))
		assertEquals(listOf("a", "b", "c", "d"), labels(run))
		assertEquals(last.at, run.getLong("until"))
		assertFalse(viewOf(listOf(first)).has("until"))
		assertFalse(viewOf(listOf(first, sameMinute)).has("until"))
	}

	@Test
	fun aLongRunListsItsNewest32RecordsAndCountsTheWholeRun() {
		val run = (1L..40L).map { quiet(it) }
		val view = viewOf(run)

		assertEquals("40 cleared quietly", view.getString("line"))
		assertEquals((9..40).map { "t$it" }, labels(view))
		assertEquals("8 earlier not listed", view.getString("earlier"))
		assertFalse(viewOf(run.takeLast(32)).has("earlier"))
	}

	@Test
	fun aLateQuietArrivalExtendsTheLastRunInPlaceAndAMessageClosesIt() {
		val page = Page()
		val start = listOf(said(1), quiet(2), quiet(3))

		page.show(start)
		page.show(start + quiet(4))
		val extended = ids(page.drawn)
		page.show(start + quiet(4) + said(5) + quiet(6))

		assertEquals(listOf(listOf(1L), listOf(2L, 3L, 4L)), extended)
		assertEquals(listOf(listOf(1L), listOf(2L, 3L, 4L), listOf(5L), listOf(6L)), ids(page.drawn))
		assertEquals(1, page.rebuilds)
	}

	@Test
	fun aClearThroughARunAsAnotherRecordLandsRedrawsRatherThanDuplicating() {
		val page = Page()

		page.show(listOf(quiet(1), quiet(2)))
		page.show(listOf(quiet(1), quiet(2), quiet(3)))
		page.show(listOf(quiet(3)))

		assertEquals(listOf(listOf(3L)), ids(page.drawn))
	}

	@Test
	fun aRetryThatMovesARowToTheEndRedrawsEachRowOnceInThreadOrder() {
		val failed = Message(true, "sent", 2L, id = 2, status = "error")
		val retried = failed.copy(status = "pending")
		val plain = listOf(said(1), failed, said(3))
		val page = Page()

		page.show(listOf(quiet(1), failed, quiet(3)))
		page.show(listOf(quiet(1), quiet(3), retried))

		assertTrue(rowDelta(threadRows(listOf(said(1), said(3), retried)), threadRows(plain)) is RowDelta.Rebuild)
		assertEquals(listOf(listOf(1L, 3L), listOf(2L)), ids(page.drawn))
	}

	@Test
	fun thePageDrawsFixedTextAndOpensOnlyAnHttpsLink() {
		val view = viewOf(listOf(Message(false, "", 1L, record = recordOf(entry(threads = listOf(done, bare))))))
		val items = view.getJSONArray("items")

		assertEquals(true, view.getBoolean("quiet"))
		assertEquals("2 cleared quietly", view.getString("line"))
		assertEquals(listOf("v2", "2"), labels(view))
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
