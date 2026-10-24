package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.board.BoardStore
import com.atelier_nyaarium.switchboard.board.PendingWrite
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

import org.junit.Assert.assertEquals
import org.junit.Test

class BoardOpsTest {
	private class FakeBoardStore : BoardStore {
		var board: String? = null
		var failNextSave = false
		override fun loadTaskBoard() = board
		override fun saveTaskBoard(json: String) {
			if (failNextSave) {
				failNextSave = false
				error("write failed")
			}
			board = json
		}
	}

	private class FakeCollaborators(store: FakeBoardStore) : BoardOpsCollaborators {
		override val board = BoardManager(store)
		override val attachmentHost: AttachmentHost get() = error("unused")
		override val boardRouter = BoardRouterWriter(board, { _, _ -> error("unused") }, { error("unused") })
		override fun boardSealing(): BoardSealing? = null
		override fun admitPicked(uris: List<Uri>, name: String) = emptyList<OutgoingFile>() to null
		override fun localDomain() = "dom"
		override val client: ConsoleClient? = null
		override fun command(block: suspend () -> Unit) = kotlinx.coroutines.runBlocking { block() }
	}

	@Test
	fun capturesShowOnTheBoardBeforeTheRouterAnswers() {
		val collaborators = FakeCollaborators(FakeBoardStore())
		val ops = BoardOps(MutableStateFlow(ChatState()), CoroutineScope(Dispatchers.Unconfined), File("/tmp/board-ops"), collaborators)

		ops.boardCapture("first", null)
		ops.boardCapture("second", "why")

		val entries = ops.boardEntries()
		assertEquals(listOf("first", "second"), entries.map { it.title })
		assertEquals(listOf(null, "why"), entries.map { it.body })
		assertEquals(listOf("open", "open"), entries.map { it.state })
	}

	@Test
	fun theAssistantIsNeverOfferedAsAnAssignee() {
		val assistant = Team("dom.gw.host.assistant", Presence.ended(), role = ASSISTANT_ROLE)
		val worker = Team("dom.gw.app.dev", Presence.ended())
		val state = MutableStateFlow(ChatState(teams = listOf(assistant, worker), gateways = testRegistry("gw")))
		val ops = BoardOps(state, CoroutineScope(Dispatchers.Unconfined), File("/tmp/board-ops"), FakeCollaborators(FakeBoardStore()))

		assertEquals(listOf(worker.name), ops.boardAssignTargets().map { it.name })
	}

	@Test
	fun refusedIntentIsShownAndNotQueued() {
		val store = FakeBoardStore().also { it.failNextSave = true }
		val collaborators = FakeCollaborators(store)
		val ops = BoardOps(MutableStateFlow(ChatState()), CoroutineScope(Dispatchers.Unconfined), File("/tmp/board-ops"), collaborators)

		ops.boardCapture("refused", null)

		assertEquals(emptyList<PendingWrite>(), collaborators.board.pendingWrites())
		assertEquals(emptyList<String>(), ops.boardEntries().map { it.title })
		assertEquals("durability_failure", ops.boardRefusals.single().reason)
	}
}
