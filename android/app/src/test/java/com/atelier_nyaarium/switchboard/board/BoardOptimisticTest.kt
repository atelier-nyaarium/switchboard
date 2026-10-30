package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.testAmbient
import com.atelier_nyaarium.switchboard.testBootstrap
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardEntryClear
import com.atelier_nyaarium.switchboard.proto.BoardEntrySealed
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStoredEntry
import com.atelier_nyaarium.switchboard.proto.BoardWriteResult
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import java.util.ArrayDeque
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardOptimisticTest {
	private class FakeStore(private var blob: String? = null) : BoardStore {
		var failNextSave = false
		var failSaves = false

		override fun loadTaskBoard(): String? = blob

		override fun saveTaskBoard(json: String) {
			if (failSaves || failNextSave) {
				failNextSave = false
				error("write failed")
			}
			blob = json
		}

	}

	private val owner = Crypto.generateIdentity()
	private val domainId = "domain"
	private val keyring = ContentKeyring().also { it.deriveOwned(owner, domainId, 1) }

	private fun sealing(ring: ContentKeyring = keyring) = BoardSealing(
		testBootstrap(domainId = domainId, owner = owner, contentKeyring = ring),
		testAmbient(nonceBytes = ByteArray(12) { 1 }),
	) {}

	private fun title(entryId: String, text: String, ring: ContentKeyring = keyring) =
		checkNotNull(sealing(ring).seal(text, BOARD_KIND_TITLE, entryId))

	private fun stored(
		id: String,
		title: ContentEnvelope,
		body: ContentEnvelope? = null,
		state: String = "open",
		parent: String? = null,
		rank: Long = 1L,
		session: BoardSession? = null,
		trashedAt: Long? = null,
		attachments: List<BoardStateAttachment>? = null,
	) = BoardStoredEntry(
		clear = BoardEntryClear(id, state, parent, rank, session, trashedAt, attachments, 1L),
		sealed = BoardEntrySealed(title, body),
	)

	private fun entry(
		id: String,
		title: String = "title-$id",
		body: String? = "body-$id",
		state: String = "open",
		parent: String? = null,
		rank: Long = 1L,
		session: BoardSession? = null,
		trashedAt: Long? = null,
	) = BoardEntry(id, title, body, state, parent, rank, session?.sessionId, session, trashedAt)

	private fun board(entry: BoardStoredEntry? = null, revision: Long = 0L) = BoardManager(FakeStore()).also {
		it.applyRouterBoard(revision, entry?.let(::listOf) ?: emptyList())
	}

	private fun writer(
		board: BoardManager,
		results: ArrayDeque<BoardWriteResult> = ArrayDeque(),
		posts: MutableList<String> = mutableListOf(),
		signAndPost: (suspend (JsonObject, String) -> JsonElement)? = null,
	) = BoardRouterWriter(
		board,
		signAndPost ?: { body, opId ->
			posts += opId
			body
		},
		{ results.removeFirst() },
	)

	@Test
	fun createSynthesizesMissingRouterEntry() {
		val session = BoardSession(domainId, "gateway", "session")
		val intent = BoardIntent.Create("id", "title", "body", "done", "parent", session)

		assertEquals(
			listOf(entry("id", "title", "body", "done", "parent", 1L, session)),
			applyPending(emptyList(), listOf(PendingWrite("op", listOf(intent)))),
		)
	}

	@Test
	fun createDoesNotOverwriteExistingRouterEntry() {
		val routerEntry = entry("id", "router title")
		val intent = BoardIntent.Create("id", "new title", state = "done")

		assertEquals(listOf(routerEntry), applyPending(listOf(routerEntry), listOf(PendingWrite("op", listOf(intent)))))
	}

	@Test
	fun editsApplyToExistingRouterEntry() {
		val session = BoardSession(domainId, "gateway", "new-session")
		val original = entry("id", session = BoardSession(domainId, "gateway", "old-session"))

		assertEquals(
			"new title",
			applyPending(listOf(original), pending(BoardIntent.SetTitle("id", "new title"))).single().title,
		)
		assertEquals("new body", applyPending(listOf(original), pending(BoardIntent.SetBody("id", "new body"))).single().body)
		assertEquals("done", applyPending(listOf(original), pending(BoardIntent.SetState("id", "done"))).single().state)
		assertEquals(session, applyPending(listOf(original), pending(BoardIntent.SetSession("id", session))).single().session)
		assertEquals(1L, applyPending(listOf(original), pending(BoardIntent.Trash("id"))).single().trashedAt)
		assertNull(applyPending(listOf(original.copy(trashedAt = 5L)), pending(BoardIntent.Restore("id"))).single().trashedAt)
		assertTrue(applyPending(listOf(original), pending(BoardIntent.Remove("id"))).isEmpty())
	}

	@Test
	fun movePlacesEntryAtIndexAndRenumbersBothSiblingGroups() {
		val entries = listOf(
			entry("root-a", rank = 1L),
			entry("parent", rank = 2L),
			entry("root-c", rank = 3L),
			entry("child-a", parent = "parent", rank = 1L),
			entry("child-b", parent = "parent", rank = 2L),
		)
		val moved = applyPending(entries, pending(BoardIntent.Move("root-c", parent = "parent", index = 1)))
		val byId = moved.associateBy { it.id }

		assertEquals(listOf("root-a", "parent"), moved.filter { it.parent == null }.sortedBy { it.rank }.map { it.id })
		assertEquals(listOf("child-a", "root-c", "child-b"), moved.filter { it.parent == "parent" }.sortedBy { it.rank }.map { it.id })
		assertEquals(2L, byId.getValue("parent").rank)
		assertEquals(1L, byId.getValue("root-a").rank)
		assertEquals(1L, byId.getValue("child-a").rank)
		assertEquals(2L, byId.getValue("root-c").rank)
		assertEquals(3L, byId.getValue("child-b").rank)
	}

	@Test
	fun trashTakesTheLiveSubtreeAndRestoreBringsBackWhatWentWithIt() {
		val board = listOf(
			entry("parent"),
			entry("kept", parent = "parent"),
			entry("gone", parent = "parent", trashedAt = 1L),
			entry("grand", parent = "kept"),
		)
		fun trashed(entries: List<BoardEntry>) = entries.filter { it.trashedAt != null }.map { it.id }.toSet()

		val binned = applyPending(board, pending(BoardIntent.Trash("parent")))
		assertEquals(setOf("parent", "kept", "gone", "grand"), trashed(binned))

		val stamped = binned.map { if (it.id == "gone") it else it.copy(trashedAt = 5L) }
		assertEquals(setOf("gone"), trashed(applyPending(stamped, pending(BoardIntent.Restore("grand")))))
	}

	@Test
	fun missingNonCreateIntentIsDropped() {
		val pending = listOf(PendingWrite("op", listOf(BoardIntent.SetState("missing", "done"))))

		assertTrue(applyPending(emptyList(), pending).isEmpty())
	}

	@Test
	fun laterPendingWriteWinsForTheSameEntry() {
		val writes = listOf(
			PendingWrite("first", listOf(BoardIntent.SetTitle("id", "first"))),
			PendingWrite("second", listOf(BoardIntent.SetTitle("id", "second"))),
		)

		assertEquals("second", applyPending(listOf(entry("id")), writes).single().title)
	}

	@Test
	fun routerOrderIsPreservedAndCreatedEntryIsAppended() {
		val router = listOf(entry("a"), entry("b"))
		val create = BoardIntent.Create("c", "created", state = "open")

		val appended = applyPending(router, listOf(PendingWrite("op", listOf(create))))
		assertEquals(listOf("a" to 1L, "b" to 2L, "c" to 3L), appended.sortedBy { it.rank }.map { it.id to it.rank })
	}

	@Test
	fun enqueueWriteReturnsQueuedWriteWithNoAttempts() {
		val board = board()
		val intents = listOf(BoardIntent.Create("id", "title", state = "open"))

		assertEquals(BoardEnqueueResult.Queued("op"), board.enqueueWrite(intents, "op"))
		assertEquals(listOf(PendingWrite("op", intents)), board.pendingWrites())
	}

	@Test
	fun enqueueWithoutIntentsRefusesWithoutReturningAnOpId() {
		val board = board()

		assertEquals(BoardEnqueueResult.Refused(null, "no_write_queued"), board.enqueueWrite(emptyList(), "op"))
		assertTrue(board.pendingWrites().isEmpty())
	}

	@Test
	fun failedEnqueueAnswersRefusalWithoutQueueing() {
		val store = FakeStore().also { it.failNextSave = true }
		val board = BoardManager(store)
		val intent = BoardIntent.Create("id", "title", state = "open")

		assertEquals(BoardEnqueueResult.Refused("id", "durability_failure"), board.enqueueWrite(listOf(intent), "op"))
		assertTrue(board.pendingWrites().isEmpty())
		assertTrue(BoardManager(store).pendingWrites().isEmpty())
	}

	@Test
	fun failedIntentRemainsVisibleWhileTheStoreKeepsFailing() {
		val board = BoardManager(FakeStore().also { it.failSaves = true })
		val intent = BoardIntent.Create("id", "title", state = "open")
		val refused = board.enqueueWrite(listOf(intent), "op") as BoardEnqueueResult.Refused

		board.noticeRefusal(refused.entryId, refused.reason)

		assertEquals(1, board.refusals.size)
		assertEquals("id", board.refusals.single().entryId)
	}

	@Test
	fun failedSubtreeAssignmentRefusalNamesItsRoot() {
		val board = BoardManager(FakeStore().also { it.failSaves = true })
		val intents = listOf(
			BoardIntent.SetSession("root", null),
			BoardIntent.SetSession("child", null),
		)

		val refused = board.enqueueWrite(intents, "op") as BoardEnqueueResult.Refused

		assertEquals("root", refused.entryId)
	}

	@Test
	fun settleWriteLandsBoardAndRetiresOnlyItsWrite() {
		val board = board()
		val first = BoardIntent.Create("first", "first", state = "open")
		val second = BoardIntent.Create("second", "second", state = "open")
		enqueue(board, first, "first")
		enqueue(board, second, "second")
		val result = stored("id", title("id", "title"))

		board.settleWrite("first", 8L, listOf(result))

		assertEquals(8L, board.routerRevision)
		assertEquals(result, board.storedById().getValue("id"))
		assertEquals(listOf(PendingWrite("second", listOf(second))), board.pendingWrites())
	}

	@Test
	fun lowerSettlementRevisionDoesNotMoveBoardBackwards() {
		val original = stored("id", title("id", "original"))
		val board = board(original, 5L)
		enqueue(board, BoardIntent.Create("new", "new", state = "open"), "op")
		val older = stored("id", title("id", "older"))

		board.settleWrite("op", 4L, listOf(older))

		assertEquals(5L, board.routerRevision)
		assertEquals(original, board.storedById().getValue("id"))
		assertTrue(board.pendingWrites().isEmpty())
	}

	@Test
	fun failWriteIncrementsAttemptsWithoutDroppingWrite() {
		val board = board()
		val intent = BoardIntent.Create("new", "new", state = "open")
		enqueue(board, intent, "op")

		board.failWrite("op")

		assertEquals(PendingWrite("op", listOf(intent), 1), board.pendingWrites().single())
	}

	@Test
	fun drainSendsOldestFirstAndStopsAtUnreachableWrite() = runBlocking {
		val board = board()
		enqueue(board, BoardIntent.Create("one", "one", state = "open"), "one")
		enqueue(board, BoardIntent.Create("two", "two", state = "open"), "two")
		enqueue(board, BoardIntent.Create("three", "three", state = "open"), "three")
		val posts = mutableListOf<String>()
		val writer = writer(board, ArrayDeque(listOf(BoardWriteResult("applied", 1L, emptyList()))), posts) { _, opId ->
			posts += opId
			if (opId == "two") error("offline")
			JsonObject(emptyMap())
		}

		assertEquals(1, writer.drain(sealing()))
		assertEquals(listOf("one", "two"), posts)
		assertEquals(listOf("two", "three"), board.pendingWrites().map { it.opId })
		assertEquals(1, board.pendingWrites().first().attempts)
	}

	@Test
	fun drainRetiresEmptyWriteWithoutPosting() = runBlocking {
		val board = board()
		enqueue(board, BoardIntent.SetTitle("missing", "title"), "op")
		val posts = mutableListOf<String>()
		val writer = writer(board, posts = posts) { _, _ -> error("must not post") }

		assertEquals(1, writer.drain(sealing()))
		assertTrue(board.pendingWrites().isEmpty())
		assertTrue(posts.isEmpty())
	}

	// Subtrees share one write.
	@Test
	fun assigningAParentCarriesItsSubtree() {
		val target = BoardSession("domain", "gw-b", "sess-b")
		val entries = listOf(entry("root"), entry("kid", parent = "root"), entry("other"))
		val write = PendingWrite(
			"op",
			listOf(BoardIntent.SetSession("root", target), BoardIntent.SetSession("kid", target)),
		)

		val applied = applyPending(entries, listOf(write)).associateBy { it.id }

		assertEquals(target, applied["root"]?.session)
		assertEquals(target, applied["kid"]?.session)
		assertEquals(null, applied["other"]?.session)
	}

	private fun pending(intent: BoardIntent) = listOf(PendingWrite("op", listOf(intent)))

	private fun enqueue(board: BoardManager, intent: BoardIntent, opId: String) {
		assertEquals(BoardEnqueueResult.Queued(opId), board.enqueueWrite(listOf(intent), opId))
	}
}
