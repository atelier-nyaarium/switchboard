package com.atelier_nyaarium.switchboard

import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private data class Note(
	override val incarnation: Long,
	override val version: String,
	val draft: String? = null,
	val stale: Boolean = false,
) : Drafted {
	override val draftKey: DraftKey get() = DraftKey.File("note-$incarnation")
	override val heldDraft: HeldDraft? get() = draft?.let { HeldDraft(version, it) }
}

class HeldEditsTest {
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")

	private fun holding(vararg notes: Note): HeldEdits<Note> {
		val dir = Files.createTempDirectory("held-edits-").toFile().apply { deleteOnExit() }
		return HeldEdits<Note>(WorkspaceDraftStore(dir, CoroutineScope(Dispatchers.Unconfined))).apply {
			apply(one) { notes.toList() }
		}
	}

	// A replace decided from what was read must not land over anything that moved while it waited.
	@Test
	fun `an untouched landing refuses any change since the read, however small`() {
		val read = Note(incarnation = 1, version = "h1", draft = "mine")
		val held = holding(read)
		held.apply(one) { notes -> notes.map { it.copy(stale = true) } }

		assertFalse(held.land(one, read, Landing.OverUntouched(read.copy(version = "h2", draft = null))))
		assertEquals(listOf(read.copy(stale = true)), held.of(one))

		val now = held.of(one).single()
		assertTrue(held.land(one, now, Landing.OverUntouched(null)))
		assertEquals(emptyList<Note>(), held.of(one))
	}

	// A fold is how an answer keeps what arrived meanwhile, and a new version or opening is not that.
	@Test
	fun `a folded landing keeps typing since the read, and refuses another version or another opening`() {
		val read = Note(incarnation = 1, version = "h1", draft = "mine")
		val held = holding(read)
		held.apply(one) { notes -> notes.map { it.copy(draft = "mine, and more") } }

		assertTrue(held.land(one, read, Landing.Folded { it.copy(version = "h2") }))
		assertEquals(listOf(Note(1, "h2", "mine, and more")), held.of(one))

		assertFalse(held.land(one, read, Landing.Folded { it.copy(stale = true) }))
		assertFalse(held.land(one, read.copy(incarnation = 2, version = "h2"), Landing.Folded { it.copy(stale = true) }))
		assertEquals(listOf(Note(1, "h2", "mine, and more")), held.of(one))
	}
}
