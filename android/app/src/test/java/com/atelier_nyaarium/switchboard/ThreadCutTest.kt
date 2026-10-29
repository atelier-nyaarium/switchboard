package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ThreadCutTest {
	private val team = "dom.sakura.host.work"
	private val other = "dom.sakura.host.other"

	private fun file(src: String) = MessageFile(name = src.substringAfterLast('/'), mime = "image/png", src = src)

	private fun inbound(id: Long, seq: Long, vararg files: MessageFile) =
		Message(fromMe = false, text = "m$id", at = 100L + id, id = id, epoch = 7L, seq = seq, files = files.toList())

	private val thread = listOf(
		inbound(0, 1, file("a/one.png")),
		inbound(1, 2, file("b/shared.png"), file("a/one.png")),
		inbound(2, 3, file("c/draft.png"), file("d/scheduled.png")),
		inbound(3, 4),
		inbound(4, 5),
	)

	private val state = ChatState(
		threads = mapOf(team to thread, other to listOf(inbound(0, 9, file("b/shared.png")))),
		drafts = mapOf(team to Draft(files = listOf(file("c/draft.png")))),
		scheduledSends = mapOf("op" to ScheduledSend("t", listOf(file("d/scheduled.png")), 0L, "op", null, 0L)),
	)

	@Test
	fun aCutFreesOnlyFilesNothingElseNames() {
		val cut = threadCut(state, team, 2L, 102L)!!

		assertEquals(listOf(0L, 1L, 2L), cut.rows.map { it.id })
		assertEquals(listOf("a/one.png"), cut.freed)
		assertNull(threadCut(state, team, 2L, 999L))
	}

	@Test
	fun aPendingSendKeepsItsFilesAndASharedAtStaysAudible() {
		val sending = Message(fromMe = true, text = "out", at = 104L, id = 5L, status = "pending", files = listOf(file("e/out.png")))
		val twin = inbound(6, 6).copy(at = 104L)
		val withSend = state.copy(threads = state.threads + (team to thread + sending + twin))
		val cut = threadCut(withSend, team, 5L, 104L)!!

		assertEquals(listOf("a/one.png"), cut.freed)
		assertEquals(setOf(100L, 101L, 102L, 103L), cut.silenced)
	}

	@Test
	fun aCutSendsEchoIsDroppedOnceAndAnEchoedRowsIsNot() {
		val sending = Message(fromMe = true, text = "out", at = 105L, id = 5L, status = "pending", opId = "op-cut")
		val echoed = Message(fromMe = true, text = "old", at = 99L, id = 9L, opId = "op-old", epoch = 7L, seq = 8L)
		val held = state.copy(threads = state.threads + (team to listOf(echoed) + thread + sending))
		val cleared = held.withCut(threadCut(held, team, 5L, 105L)!!)
		val echo = Message(fromMe = true, text = "out", at = 106L, opId = "op-cut", epoch = 7L, seq = 10L)

		val dropped = cleared.swallowEcho(echo)!!
		assertNull(dropped.swallowEcho(echo))
		assertNull(cleared.swallowEcho(echo.copy(opId = "op-old")))
	}

	@Test
	fun theAnchorStaysAndOnlyRowsAfterItCount() {
		val inside = state.copy(readAnchors = mapOf(team to ReadAnchor(7L, 2L, 101L)))
		val after = inside.withCut(threadCut(inside, team, 2L, 102L)!!)
		assertEquals(inside.readAnchors, after.readAnchors)
		assertEquals(2, after.unread[team])

		val below = state.copy(readAnchors = mapOf(team to ReadAnchor(7L, 4L, 103L)))
		val kept = below.withCut(threadCut(below, team, 1L, 101L)!!)
		assertEquals(1, kept.unread[team])
	}

	@Test
	fun aFullClearNeverMintsACutRowsIdAgain() {
		val cleared = state.withCut(threadCut(state, team, 4L, 104L)!!)

		assertEquals(emptyList<Message>(), cleared.threads[team])
		assertEquals(5L, nextRowId(cleared.threads[team].orEmpty(), cleared.idFloors[team]))
		assertEquals(0L, nextRowId(emptyList(), null))
	}

	@Test
	fun theConfirmationLeavesOutZeroLines() {
		val intro = "This will clear this message and all above it from this phone. Claude session will remain untouched."

		assertEquals(listOf(intro, "- 1 message"), clearConfirmLines(1, 0, 0L))
		assertEquals(listOf(intro, "- 123 messages", "- 2 files", "- ~789 MB recovered"), clearConfirmLines(123, 2, 789L shl 20))
	}

	@Test
	fun aFileLandingForAClearedRowIsGoneUnlessAnotherRowNamesIt() {
		val row = inbound(3, 4, MessageFile(name = "late.png", mime = "image/png", blobId = "blob"))
		val cleared = ChatState(threads = mapOf(team to listOf(inbound(0, 1))))

		assertEquals(AttachmentLanding.Gone, landedAttachment(cleared, team, 3L, "late.png", "x/late.png").first)
		val mirrored = cleared.copy(threads = cleared.threads + (other to listOf(inbound(0, 9, file("x/late.png")))))
		assertEquals(AttachmentLanding.Held, landedAttachment(mirrored, team, 3L, "late.png", "x/late.png").first)

		val (landed, next) = landedAttachment(ChatState(threads = mapOf(team to listOf(row))), team, 3L, "late.png", "x/late.png")
		assertEquals(AttachmentLanding.Landed, landed)
		assertEquals("x/late.png", next!!.threads.getValue(team).single().files.single().src)
		assertEquals(AttachmentLanding.Held, landedAttachment(next, team, 3L, "late.png", "y/late.png").first)
	}

	@Test
	fun theConfirmationCountsOnlyFreedFilesStillOnDisk() {
		val filesDir = java.io.File.createTempFile("switchboard", "cut").apply { delete(); mkdirs() }
		val bucket = java.io.File(Attachments.root(filesDir), "a").apply { mkdirs() }
		java.io.File(bucket, "one.png").writeBytes(ByteArray(2048))
		val root = Attachments.root(filesDir).path

		assertEquals(FreedSize(1, 2048L), freedSize(filesDir, listOf("$root/a/one.png", "$root/a/missing.png")))
	}
}
