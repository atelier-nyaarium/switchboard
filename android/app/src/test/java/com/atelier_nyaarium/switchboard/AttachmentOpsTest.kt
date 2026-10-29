package com.atelier_nyaarium.switchboard

import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentOpsTest {
	@Test
	fun orphanSweepRemovesUnreferencedBuckets() = runBlocking {
		val root = File.createTempFile("switchboard", "attachments").apply { delete(); mkdirs() }
		val bucket = File(Attachments.root(root), "blob-orphan").apply { mkdirs() }
		File(bucket, "bytes").writeText("orphan")
		bucket.setLastModified(System.currentTimeMillis() - Attachments.ORPHAN_SWEEP_MIN_AGE_MS - 1L)
		val store = testStore()
		val state = MutableStateFlow(ChatState())
		val ops = AttachmentOps(
			state,
			ChatPersistence(store) { state.value },
			FailingClientPort,
			TestIdentityPort(store),
			root,
			{ null },
			object : AttachmentOpsCollaborators {
				override fun clientOrNull(): ConsoleClient? = null
				override fun attachmentBuckets() = emptySet<String>()
			},
		)

		ops.sweepOrphanAttachments()

		assertFalse(bucket.exists())
	}

	@Test
	fun aDeleteKeepsWhatADraftStillNames() {
		val root = File.createTempFile("switchboard", "attachments").apply { delete(); mkdirs() }
		val bucket = File(Attachments.root(root), "out-1").apply { mkdirs() }
		val kept = File(bucket, "kept.png").apply { writeText("kept") }
		val gone = File(bucket, "gone.png").apply { writeText("gone") }
		val keptSrc = "${Attachments.root(root).path}/out-1/kept.png"
		val draft = Draft(files = listOf(MessageFile(name = "kept.png", mime = "image/png", src = keptSrc)))
		val state = MutableStateFlow(ChatState(drafts = mapOf("dom.gw.host.work" to draft)))
		val store = testStore()
		val ops = AttachmentOps(
			state,
			ChatPersistence(store) { state.value },
			FailingClientPort,
			TestIdentityPort(store),
			root,
			{ null },
			object : AttachmentOpsCollaborators {
				override fun clientOrNull(): ConsoleClient? = null
				override fun attachmentBuckets() = emptySet<String>()
			},
		)

		assertTrue(ops.deleteWhenDurable(listOf(keptSrc, "${Attachments.root(root).path}/out-1/gone.png")))
		assertTrue(kept.exists())
		assertFalse(gone.exists())
	}
}
