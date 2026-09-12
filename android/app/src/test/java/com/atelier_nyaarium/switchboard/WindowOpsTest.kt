package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
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
	}

	private class FakeHost(override val workspace: WorkspaceGateway?) : WindowHost

	private lateinit var dir: File
	private lateinit var gateway: FakeWorkspace
	private lateinit var drafts: WindowDraftStore
	private lateinit var ops: WindowOps

	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")
	private val two = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.bbb")

	/** Unconfined, so a draft write has landed by the time the call that started it returns. */
	private fun opsOver(store: WindowDraftStore, host: WindowHost = FakeHost(gateway)) =
		WindowOps(host, store, CoroutineScope(Dispatchers.Unconfined))

	@Before
	fun setUp() {
		dir = Files.createTempDirectory("window-ops-").toFile()
		gateway = FakeWorkspace()
		gateway.spans[F_ID] = "fun f() {}" to "h1"
		gateway.spans[G_ID] = "fun g() {}" to "h2"
		drafts = WindowDraftStore(dir)
		ops = opsOver(drafts)
	}

	@After
	fun tearDown() {
		dir.deleteRecursively()
	}

	private fun shownIn(held: WindowOps, target: WorkspaceTarget) =
		held.windowsOf(target).map { it.descriptor.symbolId to it.shown }

	private fun shown(target: WorkspaceTarget = one) = shownIn(ops, target)

	@Test
	fun `no gateway reads as unreachable rather than throwing`() = runBlocking {
		val none = opsOver(drafts, FakeHost(null))

		assertEquals(WorkspaceAnswer.Unreachable, none.tree(one, ""))
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

		val next = opsOver(WindowDraftStore(dir))
		next.openWindow(one, F_ID)

		assertEquals(listOf(F_ID to "fun f() { mine() }"), shownIn(next, one))
	}

	@Test
	fun `closing leaves the other windows and drops the draft`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.openWindow(one, G_ID)
		ops.type(one, F_ID, "mine")

		ops.closeWindow(one, F_ID)

		assertEquals(listOf(G_ID to "fun g() {}"), shown())
		assertNull(drafts.load(one, F_ID))
	}

	@Test
	fun `typing into a window nothing holds changes nothing`() = runBlocking {
		ops.type(one, F_ID, "mine")

		assertEquals(emptyList<Pair<String, String>>(), shown())
		assertNull(drafts.load(one, F_ID))
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

	// An answer the owner has already moved past must not put back what they left.
	@Test
	fun `an overtaken read of one session is dropped`() = runBlocking {
		val hold = TestHold().also { gateway.holds[F_ID] = it }

		val slow = async { ops.openWindow(one, F_ID) }
		hold.entered.await()
		ops.openWindow(one, G_ID)
		hold.release()

		assertEquals(WorkspaceAnswer.Unreachable, slow.await())
		assertEquals(listOf(G_ID to "fun g() {}"), shown())
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
		assertNull(drafts.load(one, F_ID))
		assertTrue(adopted is WorkspaceAnswer.Read)
	}

	@Test
	fun `a refused adopt leaves the window and the draft alone`() = runBlocking {
		ops.openWindow(one, F_ID)
		ops.type(one, F_ID, "mine")
		gateway.refusing += F_ID

		assertEquals(WorkspaceAnswer.Refused("withheld"), ops.adopt(one, F_ID))
		assertEquals(listOf(F_ID to "mine"), shown())
		assertEquals("mine", drafts.load(one, F_ID))
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
	fun `every read names the session it is asked about`() = runBlocking {
		assertEquals("src/a.ts", (ops.tree(one, "src/a.ts") as WorkspaceAnswer.Read).value.path)
		assertEquals("whole file", (ops.file(one, "src/a.ts") as WorkspaceAnswer.Read).value.text)
		assertEquals("src/a.ts", (ops.outline(one, "src/a.ts") as WorkspaceAnswer.Read).value.path)
		assertEquals(F_ID, (ops.symbol(one, F_ID) as WorkspaceAnswer.Read).value.symbolId)
		assertEquals(F_ID, (ops.knowledge(one, F_ID) as WorkspaceAnswer.Read).value.symbolId)
		assertEquals(listOf(one, one, one, one, one), gateway.asked)
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
