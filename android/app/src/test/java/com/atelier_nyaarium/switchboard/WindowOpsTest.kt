package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private const val F_ID = "lexicon typescript src/a.ts f()."
private const val G_ID = "lexicon typescript src/a.ts g()."

private fun sourceAnswer(symbolId: String, text: String, hash: String) =
	WorkspaceSymbolSourceAnswer(
		symbolId = symbolId,
		module = "src/a.ts",
		name = symbolId.substringAfterLast(' ').takeWhile { it != '(' },
		text = text,
		startLine = 4,
		endLine = 9,
		spanHash = hash,
	)

class WindowOpsTest {
	/** Spans per symbol, and a hold the next read of one waits at. */
	private class FakeWorkspace : WorkspaceGateway {
		val spans = mutableMapOf<String, Pair<String, String>>()
		val refusing = mutableSetOf<String>()
		val holds = mutableMapOf<String, TestHold>()

		/** Which session each call named, so a read cannot quietly ask about another workspace. */
		val asked = mutableListOf<WorkspaceTarget>()

		override suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer> {
			asked += target
			return WorkspaceAnswer.Read(WorkspaceTreeAnswer(path = path, entries = emptyList(), truncated = false))
		}

		override suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> {
			asked += target
			return WorkspaceAnswer.Read(WorkspaceReadAnswer(path = path, text = "whole file", lines = 1))
		}

		override suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer> {
			asked += target
			return WorkspaceAnswer.Read(WorkspaceOutlineAnswer(path = path, symbols = emptyList()))
		}

		override suspend fun symbolSource(
			target: WorkspaceTarget,
			symbolId: String,
		): WorkspaceAnswer<WorkspaceSymbolSourceAnswer> {
			asked += target
			// Read before the hold, so a held answer is the older one.
			val span = spans[symbolId]
			holds.remove(symbolId)?.pass()
			if (symbolId in refusing) return WorkspaceAnswer.Refused("withheld")
			val (text, hash) = span ?: return WorkspaceAnswer.Refused("no such symbol")
			return WorkspaceAnswer.Read(sourceAnswer(symbolId, text, hash))
		}

		override suspend fun knowledge(
			target: WorkspaceTarget,
			symbolId: String,
		): WorkspaceAnswer<WorkspaceKnowledgeAnswer> {
			asked += target
			return WorkspaceAnswer.Read(WorkspaceKnowledgeAnswer(symbolId = symbolId, text = "what is known"))
		}

		/**
		 * Writes only while the hash matches, as Lexicon does. `lost` writes and answers nothing, `unread`
		 * writes and cannot read the span back, `gone` writes and the span no longer resolves.
		 */
		var lost = false
		var unread = false
		var gone = false
		val saveHolds = mutableMapOf<String, TestHold>()
		val answerHolds = mutableMapOf<String, TestHold>()
		val saved = mutableListOf<Pair<String, String>>()

		override suspend fun saveSpan(
			target: WorkspaceTarget,
			symbolId: String,
			expectedSpanHash: String,
			text: String,
		): WorkspaceAnswer<WorkspaceSaveSpanAnswer> {
			asked += target
			saveHolds.remove(symbolId)?.pass()
			if (symbolId in refusing) return WorkspaceAnswer.Refused("withheld")
			val (_, hash) = spans[symbolId] ?: return WorkspaceAnswer.Read(
				WorkspaceSaveSpanAnswer(symbolId = symbolId, outcome = SAVE_REJECTED, reason = "no such symbol"),
			)
			if (hash != expectedSpanHash) {
				val (heldText, heldHash) = spans.getValue(symbolId)
				return WorkspaceAnswer.Read(
					WorkspaceSaveSpanAnswer(symbolId = symbolId, outcome = SAVE_STALE, current = sourceAnswer(symbolId, heldText, heldHash)),
				)
			}
			spans[symbolId] = text to "saved:$text"
			saved += symbolId to text
			answerHolds.remove(symbolId)?.pass()
			if (lost) return WorkspaceAnswer.Unreachable
			if (gone) spans.remove(symbolId)
			return WorkspaceAnswer.Read(
				WorkspaceSaveSpanAnswer(
					symbolId = symbolId,
					outcome = SAVE_SAVED,
					current = if (unread || gone) null else sourceAnswer(symbolId, text, "saved:$text"),
					gone = if (gone) true else null,
					joined = false,
				),
			)
		}

		override suspend fun mutateFile(
			target: WorkspaceTarget,
			mutation: WorkspaceFileMutation,
		): WorkspaceAnswer<WorkspaceFileMutationAnswer> = WorkspaceAnswer.Refused("not a file test")

		override suspend fun fileState(target: WorkspaceTarget, path: String) = error("not reached")
	}

	/** Records what was sent, since an apply is an ordinary message and nothing else marks it. */
	private class FakeHost(override val workspace: WorkspaceGateway?) : WorkspaceHost {
		override val generation = WorkspaceGeneration()
		val sent = mutableListOf<Pair<String, String>>()
		var sends = true
		var throws = false

		override suspend fun send(address: String, text: String): Boolean {
			if (throws) throw IllegalStateException("the Router was not reached")
			if (!sends) return false
			sent += address to text
			return true
		}
	}

	private lateinit var dir: File
	private lateinit var gateway: FakeWorkspace
	private lateinit var host: FakeHost
	private lateinit var drafts: WorkspaceDraftStore
	private lateinit var ops: WindowOps

	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")
	private val two = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.bbb")

	/** Unconfined, so the store's queue drains on the calling thread. */
	private fun draftsOver(over: File) = WorkspaceDraftStore(over, CoroutineScope(Dispatchers.Unconfined))

	private fun opsOver(store: WorkspaceDraftStore, over: WorkspaceHost = host) = WindowOps(over, store)

	@Before
	fun setUp() {
		dir = Files.createTempDirectory("window-ops-").toFile()
		gateway = FakeWorkspace()
		gateway.spans[F_ID] = "fun f() {}" to "h1"
		gateway.spans[G_ID] = "fun g() {}" to "h2"
		host = FakeHost(gateway)
		drafts = draftsOver(dir)
		ops = opsOver(drafts)
	}

	@After
	fun tearDown() {
		dir.deleteRecursively()
	}

	private suspend fun draftOf(target: WorkspaceTarget, symbolId: String) = drafts.load(target, DraftKey.Span(symbolId))?.text

	private fun shownIn(held: WindowOps, target: WorkspaceTarget) =
		held.windowsOf(target).map { it.descriptor.symbolId to it.shown }

	private fun shown(target: WorkspaceTarget = one) = shownIn(ops, target)

	@Test
	fun `no gateway reads as unreachable rather than throwing`() = runBlocking {
		val none = opsOver(drafts, FakeHost(null))

		assertEquals(WorkspaceAnswer.Unreachable, none.openWindow(one, F_ID))
		assertEquals(emptyList<Window>(), none.windowsOf(one))
	}

	// A withheld file is the gateway's word; collapsing it to unreachable reads as a dropped link.
	@Test
	fun `a refusal opens no window and stays a refusal`() = runBlocking {
		gateway.refusing += F_ID

		assertEquals(WorkspaceAnswer.Refused("withheld"), ops.openWindow(one, F_ID))
		assertEquals(emptyList<Window>(), ops.windowsOf(one))
	}

	@Test
	fun `a long press accumulates and the same symbol twice adds nothing`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.openWindow(one, F_ID)

		assertEquals(listOf(F_ID to "fun f() {}", G_ID to "fun g() {}"), shown())
	}

	@Test
	fun `two sessions of one gateway hold separate windows`() = runBlocking {
		ops.openWindow(one, F_ID)

		assertEquals(emptyList<Pair<String, String>>(), shown(two))
	}

	@Test
	fun `a draft survives a fresh ops class over the same directory`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "fun f() { mine() }")

		val next = opsOver(draftsOver(dir))
		next.openWindow(one, F_ID)

		assertEquals(listOf(F_ID to "fun f() { mine() }"), shownIn(next, one))
	}

	// Saving stale typing would overwrite moved content.
	@Test
	fun `a draft reopened over a span that moved comes back stale, and its save is refused as stale`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "fun f() { mine() }")
		gateway.spans[F_ID] = "fun f() { agent() }" to "h9"

		val next = opsOver(draftsOver(dir))
		next.openWindow(one, F_ID)

		assertTrue(next.windowsOf(one).single().stale)
		assertEquals(listOf(F_ID to "fun f() { mine() }"), shownIn(next, one))
		assertEquals(SaveReport(stale = 1), next.save(one))
		assertEquals("fun f() { agent() }" to "h9", gateway.spans[F_ID])
	}

	@Test
	fun `closing leaves the other windows and drops the draft`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.type(one, F_ID, "mine")

		ops.closeWindow(one, F_ID)

		assertEquals(listOf(G_ID to "fun g() {}"), shown())
		assertNull(draftOf(one, F_ID))
	}

	@Test
	fun `typing into a window nothing holds changes nothing`() = runBlocking {
		ops.type(one, F_ID, "mine")

		assertEquals(emptyList<Pair<String, String>>(), shown())
		assertNull(draftOf(one, F_ID))
	}

	@Test
	fun `a recheck adopts a moved span when nothing of the owner's is at stake`() = runBlocking {
		ops.openWindow(one, F_ID)
		gateway.spans[F_ID] = "fun f() { moved() }" to "h9"

		ops.recheck(one)

		assertEquals(listOf(F_ID to "fun f() { moved() }"), shown())
		assertEquals(listOf(false), ops.windowsOf(one).map { it.stale })
	}

	@Test
	fun `a recheck keeps the owner's typing and marks it stale`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.spans[F_ID] = "theirs" to "h9"

		ops.recheck(one)

		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(true), ops.windowsOf(one).map { it.stale })
	}

	// The sweep must not write back a whole snapshot, or a window opened mid-sweep disappears.
	@Test
	fun `a window opened during a recheck survives it`() = runBlocking {
		ops.openWindow(one, F_ID)
		gateway.spans[F_ID] = "fun f() { moved() }" to "h9"
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val sweep = launch { ops.recheck(one) }
		hold.entered.await()
		ops.openWindow(one, G_ID)
		hold.release()
		sweep.join()

		assertEquals(listOf(F_ID to "fun f() { moved() }", G_ID to "fun g() {}"), shown())
	}

	// The whole reason a sweep decides inside the apply: the owner types while it is in flight.
	@Test
	fun `typing during a recheck is not overwritten by the answer it was waiting for`() = runBlocking {
		ops.openWindow(one, F_ID)
		gateway.spans[F_ID] = "fun f() { moved() }" to "h9"
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val sweep = launch { ops.recheck(one) }
		hold.entered.await()
		ops.type(one, F_ID, "mine")
		hold.release()
		sweep.join()

		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(true), ops.windowsOf(one).map { it.stale })
	}

	// The mirror of the above: a sweep must not resurrect a window the owner closed while it ran.
	@Test
	fun `a window closed during a recheck stays closed`() = runBlocking {
		ops.openWindow(one, F_ID)
		gateway.spans[F_ID] = "fun f() { moved() }" to "h9"
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val sweep = launch { ops.recheck(one) }
		hold.entered.await()
		ops.closeWindow(one, F_ID)
		hold.release()
		sweep.join()

		assertEquals(emptyList<Pair<String, String>>(), shown())
	}

	// A symbol id names which span, not which OPENING of it, so the old answer belongs to neither.
	@Test
	fun `a sweep does not land on the window that replaced the one it read`() = runBlocking {
		ops.openWindow(one, F_ID)
		gateway.spans[F_ID] = "fun f() { moved() }" to "h9"
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val sweep = launch { ops.recheck(one) }
		hold.entered.await()
		ops.closeWindow(one, F_ID)
		gateway.spans[F_ID] = "fun f() { newest }" to "h11"
		ops.openWindow(one, F_ID)
		hold.release()
		sweep.join()

		assertEquals(listOf(F_ID to "fun f() { newest }"), shown())
	}

	// A window closed while its own read was in flight is one the owner does not want back.
	@Test
	fun `an open that lands after its close adds nothing`() = runBlocking {
		ops.openWindow(one, F_ID)
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val reopen = async { ops.openWindow(one, F_ID) }
		hold.entered.await()
		ops.closeWindow(one, F_ID)
		hold.release()
		reopen.await()

		assertEquals(emptyList<Pair<String, String>>(), shown())
	}

	// The previous owner's code must not arrive after the wipe that was meant to take it.
	@Test
	fun `an open that lands after a re-provision adds nothing`() = runBlocking {
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val opening = async { ops.openWindow(one, F_ID) }
		hold.entered.await()
		host.generation.advance()
		ops.clearInMemory()
		hold.release()
		opening.await()

		assertEquals(emptyList<Pair<String, String>>(), shown())
	}

	// An answer the owner has already moved past must not put back what they left.
	@Test
	fun `an overtaken read of the same thing is dropped`() = runBlocking {
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val slow = async { ops.openWindow(one, F_ID) }
		hold.entered.await()
		gateway.spans[F_ID] = "fun f() { newer }" to "h7"
		ops.openWindow(one, F_ID)
		hold.release()

		assertEquals(WorkspaceAnswer.Unreachable, slow.await())
		assertEquals(listOf(F_ID to "fun f() { newer }"), shown())
	}

	// A symbol's source and its knowledge are two things on one screen, not one read racing itself.
	@Test
	fun `reading two different things at once does not cancel either`() = runBlocking {
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val source = async { ops.symbol(one, F_ID) }
		hold.entered.await()
		val known = ops.knowledge(one, F_ID)
		hold.release()

		assertTrue(source.await() is WorkspaceAnswer.Read)
		assertTrue(known is WorkspaceAnswer.Read)
	}

	// One counter per session, or a slow read of one session discards a fresh read of another.
	@Test
	fun `a slow read of one session leaves another session's read alone`() = runBlocking {
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val slow = async { ops.openWindow(one, F_ID) }
		hold.entered.await()
		ops.openWindow(two, G_ID)
		hold.release()

		assertTrue(slow.await() is WorkspaceAnswer.Read)
		assertEquals(listOf(F_ID to "fun f() {}"), shown(one))
		assertEquals(listOf(G_ID to "fun g() {}"), shown(two))
	}

	// The banner's Refresh: the owner chose the file's text, so their draft goes with it.
	@Test
	fun `adopting takes the file's text and discards the draft`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.spans[F_ID] = "theirs" to "h9"

		val adopted = ops.adopt(one, F_ID)

		assertEquals(listOf(F_ID to "theirs"), shown())
		assertEquals(listOf(false), ops.windowsOf(one).map { it.stale })
		assertNull(draftOf(one, F_ID))
		assertTrue(adopted is WorkspaceAnswer.Read)
	}

	// The tap chose the file's text as it stood; typing after the tap is newer than that choice.
	@Test
	fun `typing while a Refresh reads outranks it`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.spans[F_ID] = "theirs" to "h9"
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val adopting = async(Dispatchers.Default) { ops.adopt(one, F_ID) }
		hold.entered.await()
		ops.type(one, F_ID, "mine, and more")
		hold.release()
		adopting.await()

		assertEquals(listOf(F_ID to "mine, and more"), shown())
		assertEquals("mine, and more", draftOf(one, F_ID))
	}

	@Test
	fun `a refused adopt leaves the window and the draft alone`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.refusing += F_ID

		assertEquals(WorkspaceAnswer.Refused("withheld"), ops.adopt(one, F_ID))
		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals("mine", draftOf(one, F_ID))
	}

	// A window that adopted holds no draft, so a reopen must not restore one from disk.
	@Test
	fun `a recheck that adopts the owner's own text takes the draft file with it`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.spans[F_ID] = "mine" to "h9"

		ops.recheck(one)

		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(false), ops.windowsOf(one).map { it.edited })
		assertNull(draftOf(one, F_ID))
	}

	// Typing back to the original leaves a draft file behind an unedited window.
	@Test
	fun `a recheck that adopts takes any held draft, not only a differing one`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "fun f() {}")
		gateway.spans[F_ID] = "moved" to "h9"

		ops.recheck(one)

		assertNull(draftOf(one, F_ID))
	}

	// The fence supersedes this adopt, since a reopen claims the same slot; the incarnation guard in
	// `adopt` is the second line for a window that goes away by some other road.
	@Test
	fun `an adopt that lands after a reopen leaves the new draft alone`() = runBlocking {
		ops.openWindow(one, F_ID)
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val refresh = async { ops.adopt(one, F_ID) }
		hold.entered.await()
		ops.closeWindow(one, F_ID)
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "typed after the reopen")
		hold.release()
		refresh.await()

		assertEquals(listOf(F_ID to "typed after the reopen"), shown())
		assertEquals("typed after the reopen", draftOf(one, F_ID))
	}

	// A sweep answer describing a version the window has moved past is older news than what it shows.
	// Nothing else catches it: the sweep is unfenced, the incarnation is unchanged by an adopt, and
	// `refreshWith` compares hashes for equality alone, so it would read the older text as a catch-up.
	@Test
	fun `a sweep answer that lands after the owner's refresh does not put the old span back`() = runBlocking {
		ops.openWindow(one, F_ID)
		gateway.spans[F_ID] = "swept" to "h2"
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val sweep = async { ops.recheck(one) }
		hold.entered.await()
		gateway.spans[F_ID] = "refreshed" to "h3"
		ops.adopt(one, F_ID)
		hold.release()
		sweep.await()

		assertEquals(listOf(F_ID to "refreshed"), shown())
	}

	// A transient refusal is not a reason to throw away what the owner is looking at.
	@Test
	fun `a recheck that cannot read a span leaves it as it was`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.refusing += F_ID

		ops.recheck(one)

		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(false), ops.windowsOf(one).map { it.stale })
	}

	// The foreground hook calls this one, and it must reach every session with a window open.
	@Test
	fun `rechecking everything reaches every session holding a window`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(two, G_ID)
		gateway.spans[F_ID] = "f moved" to "h8"
		gateway.spans[G_ID] = "g moved" to "h9"

		ops.recheckAll()

		assertEquals(listOf(F_ID to "f moved"), shown(one))
		assertEquals(listOf(G_ID to "g moved"), shown(two))
	}

	@Test
	fun `a window's file is read once and kept`() = runBlocking {
		ops.openWindow(one, F_ID)

		assertEquals(listOf("whole file"), ops.contextFor(one, "src/a.ts"))
		ops.contextFor(one, "src/a.ts")

		assertEquals(1, gateway.asked.size - 1)
	}

	// Unfenced: a tap landing mid-read would otherwise leave that file without context for good.
	@Test
	fun `a context read is not dropped by a newer read of the session`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)

		assertEquals(listOf("whole file"), ops.contextFor(one, "src/a.ts"))
	}

	@Test
	fun `the last window of a file closing lets its context go`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.contextFor(one, "src/a.ts")
		val before = gateway.asked.size

		ops.closeWindow(one, F_ID)
		ops.contextFor(one, "src/a.ts")

		assertEquals(before + 1, gateway.asked.size)
	}

	@Test
	fun `every read names the session it is asked about`() = runBlocking {
		assertEquals("whole file", (ops.file(one, "src/a.ts") as WorkspaceAnswer.Read).value.text)
		assertEquals("src/a.ts", (ops.outline(one, "src/a.ts") as WorkspaceAnswer.Read).value.path)
		assertEquals(F_ID, (ops.symbol(one, F_ID) as WorkspaceAnswer.Read).value.symbolId)
		assertEquals(F_ID, (ops.knowledge(one, F_ID) as WorkspaceAnswer.Read).value.symbolId)
		assertEquals(listOf(one, one, one, one), gateway.asked)
	}

	@Test
	fun `an apply goes to the session as one message naming every edited span`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.type(one, G_ID, "fun g() { mine() }")

		assertEquals(Applied.Sent(1), ops.agentApply(one))

		val (address, text) = host.sent.single()
		assertEquals(one.address, address)
		assertTrue(text.contains(G_ID))
		assertTrue(text.contains("fun g() { mine() }"))
		assertFalse(text.contains(F_ID))
	}

	@Test
	fun `an apply with nothing edited sends nothing`() = runBlocking {
		ops.openWindow(one, F_ID)

		assertEquals(Applied.NothingEdited, ops.agentApply(one))
		assertEquals(emptyList<Pair<String, String>>(), host.sent.toList())
	}

	// The agent may refuse a span whose file moved, so the owner's only copy of what they wanted stays.
	@Test
	fun `an apply keeps the drafts, sent or not`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")

		ops.agentApply(one)
		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals("mine", draftOf(one, F_ID))

		host.sends = false
		assertEquals(Applied.Failed, ops.agentApply(one))
		assertEquals(listOf(F_ID to "mine"), shown())
	}

	// A throw would otherwise take the screen's coroutine with it, leaving the button looking dead.
	@Test
	fun `a send that throws is a failure, not a lost coroutine`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		host.throws = true

		assertEquals(Applied.Failed, ops.agentApply(one))
	}

	@Test
	fun `a save writes only the edited spans and leaves each window showing what is on disk`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.type(one, G_ID, "fun g() { mine() }")

		assertEquals(SaveReport(saved = 1), ops.save(one))

		assertEquals(listOf(G_ID to "fun g() { mine() }"), gateway.saved.toList())
		assertEquals(listOf(F_ID to "fun f() {}", G_ID to "fun g() { mine() }"), shown())
		assertEquals(listOf(false, false), ops.windowsOf(one).map { it.edited })
		assertNull(draftOf(one, G_ID))
	}

	// A second save must be checked against what the first one wrote, not what the window first showed.
	@Test
	fun `a saved window saves again against its new span`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "first")
		ops.save(one)
		ops.type(one, F_ID, "second")

		assertEquals(SaveReport(saved = 1), ops.save(one))
		assertEquals(listOf(F_ID to "second"), shown())
	}

	@Test
	fun `typing that lands while a save is in flight stays as the draft`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "sent")
		val hold = TestHold().also { gateway.saveHolds[F_ID] = it }

		val saving = async { ops.save(one) }
		hold.entered.await()
		ops.type(one, F_ID, "sent, and more")
		hold.release()
		saving.await()

		assertEquals(listOf(F_ID to "sent, and more"), shown())
		assertEquals(listOf(true), ops.windowsOf(one).map { it.edited })
		assertEquals("sent, and more", draftOf(one, F_ID))
	}

	@Test
	fun `a span that moved under the owner is not written and raises the banner with their typing kept`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.spans[F_ID] = "theirs" to "h9"

		assertEquals(SaveReport(stale = 1), ops.save(one))

		assertEquals(emptyList<Pair<String, String>>(), gateway.saved.toList())
		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(true), ops.windowsOf(one).map { it.stale })
	}

	@Test
	fun `a refused save leaves the window and its draft alone`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.refusing += F_ID

		assertEquals(SaveReport(refused = listOf("withheld")), ops.save(one))
		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals("mine", draftOf(one, F_ID))
	}

	// No answer is not "not saved": the span is read back, and one holding the owner's text is adopted.
	@Test
	fun `a save that landed without an answer is reconciled by reading the span back`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.lost = true

		assertEquals(SaveReport(unknown = 1), ops.save(one))

		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(false), ops.windowsOf(one).map { it.edited })
		assertNull(draftOf(one, F_ID))
	}

	// The answer describes the span as the save left it; a refresh that landed since has read later.
	@Test
	fun `a save answer that lands after a newer read does not put the older span back`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		val hold = TestHold().also { gateway.answerHolds[F_ID] = it }

		val saving = async { ops.save(one) }
		hold.entered.await()
		gateway.spans[F_ID] = "the agent's" to "h9"
		ops.adopt(one, F_ID)
		hold.release()
		saving.await()

		assertEquals(listOf(F_ID to "the agent's"), shown())
	}

	// A read back that failed says nothing about the span, so the window and its typing stay.
	@Test
	fun `a save whose span could not be read back keeps the window and settles it by re-reading`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.unread = true

		assertEquals(SaveReport(saved = 1, unread = 1), ops.save(one))
		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals(listOf(false), ops.windowsOf(one).map { it.edited })
	}

	@Test
	fun `a save whose span no longer resolves closes the window and lets its file's context go`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.contextFor(one, "src/a.ts")
		ops.type(one, F_ID, "")
		gateway.gone = true
		val before = gateway.asked.size

		ops.save(one)
		ops.contextFor(one, "src/a.ts")

		assertEquals(emptyList<Pair<String, String>>(), shown())
		assertNull(draftOf(one, F_ID))
		assertEquals(before + 2, gateway.asked.size)
	}

	// Closing is how the owner abandons a draft, so a save already under way must not write it.
	@Test
	fun `a window closed while an earlier span saves is not written, and its reopening is not either`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.type(one, F_ID, "f mine")
		ops.type(one, G_ID, "g abandoned")
		val hold = TestHold().also { gateway.saveHolds[F_ID] = it }

		val saving = async { ops.save(one) }
		hold.entered.await()
		ops.closeWindow(one, G_ID)
		ops.openWindow(one, G_ID)
		hold.release()
		saving.await()

		assertEquals(listOf(F_ID to "f mine"), gateway.saved.toList())
		assertEquals(listOf(F_ID to "f mine", G_ID to "fun g() {}"), shown())
	}

	@Test
	fun `a save answer this build does not know is settled by reading the span back`() = runBlocking {
		val newer = object : WorkspaceGateway by gateway {
			override suspend fun saveSpan(target: WorkspaceTarget, symbolId: String, expectedSpanHash: String, text: String) =
				gateway.saveSpan(target, symbolId, expectedSpanHash, text).let {
					WorkspaceAnswer.Read(WorkspaceSaveSpanAnswer(symbolId = symbolId, outcome = "committed"))
				}
		}
		val later = opsOver(drafts, FakeHost(newer))
		later.openWindow(one, F_ID)
		later.type(one, F_ID, "mine")

		assertEquals(SaveReport(unknown = 1), later.save(one))
		assertEquals(listOf(false), later.windowsOf(one).map { it.edited })
	}

	@Test
	fun `a save that lands after its window closed adds nothing back`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		val hold = TestHold().also { gateway.saveHolds[F_ID] = it }

		val saving = async { ops.save(one) }
		hold.entered.await()
		ops.closeWindow(one, F_ID)
		hold.release()
		saving.await()

		assertEquals(emptyList<Pair<String, String>>(), shown())
	}

	@Test
	fun `only edited windows are asked about`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.type(one, G_ID, "fun g() { mine() }")

		assertEquals(
			listOf(
				AgentRequest(
					module = "src/a.ts",
					symbolId = G_ID,
					original = "fun g() {}",
					proposed = "fun g() { mine() }",
				),
			),
			ops.agentRequests(one),
		)
	}
}
