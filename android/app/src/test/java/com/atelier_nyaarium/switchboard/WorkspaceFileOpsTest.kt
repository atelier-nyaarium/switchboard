package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private const val APP = "src/app.ts"

class WorkspaceFileOpsTest {
	/** The plugin's rules through `WorkspaceFileTable`, with the losses a plane can suffer. */
	private class FakeDisk : WorkspaceGateway by NotReached {
		val table = WorkspaceFileTable(folders = listOf("src", "lib"), files = mapOf(APP to "const x = 1;"))
		val sent = mutableListOf<WorkspaceFileMutation>()
		val tooLarge = mutableSetOf<String>()

		/** A path answering as another name for the same file, as a move cut short leaves it. */
		val aliases = mutableMapOf<String, String>()
		val stateHolds = mutableListOf<TestHold>()
		val mutationHolds = mutableListOf<TestHold>()
		val treeHolds = mutableListOf<TestHold>()
		var treeReads = 0

		/** Applies, then answers nothing. */
		var lostAfter = false

		/** Answers nothing, and applies nothing. */
		var lostBefore = false

		/** Applies nothing, and answers `unknown` with this reason. */
		var unknown: String? = null

		/** State reads fail once more than this many mutations were sent. */
		var unreadableAfter: Int? = null

		override suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer> {
			treeReads++
			treeHolds.removeFirstOrNull()?.pass()
			return table.tree(path)
		}

		override suspend fun fileState(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceFileStateAnswer> {
			if (unreadableAfter?.let { sent.size > it } == true) return WorkspaceAnswer.Unreachable
			val state = table.state(aliases[path] ?: path)
			stateHolds.removeFirstOrNull()?.pass()
			val read = (state as? WorkspaceAnswer.Read)?.value ?: return state
			val named = read.copy(path = path)
			return WorkspaceAnswer.Read(if (path in tooLarge) named.copy(hash = null, identity = null) else named)
		}

		override suspend fun mutateFile(
			target: WorkspaceTarget,
			mutation: WorkspaceFileMutation,
		): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
			mutationHolds.removeFirstOrNull()?.pass()
			sent += mutation
			if (lostBefore) return WorkspaceAnswer.Unreachable
			unknown?.let { reason ->
				val path = when (mutation) {
					is WorkspaceFileMutation.Write -> mutation.path
					is WorkspaceFileMutation.Create -> mutation.path
					is WorkspaceFileMutation.Delete -> mutation.path
					is WorkspaceFileMutation.Move -> mutation.path
					is WorkspaceFileMutation.Copy -> mutation.path
				}
				return WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = path, outcome = "unknown", reason = reason))
			}
			val answer = table.mutate(mutation)
			return if (lostAfter) WorkspaceAnswer.Unreachable else answer
		}
	}

	private object NotReached : WorkspaceGateway {
		override suspend fun tree(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun file(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun outline(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun symbolSource(target: WorkspaceTarget, symbolId: String) = error("not reached")

		override suspend fun knowledge(target: WorkspaceTarget, symbolId: String) = error("not reached")

		override suspend fun saveSpan(target: WorkspaceTarget, symbolId: String, expectedSpanHash: String, text: String) =
			error("not reached")

		override suspend fun mutateFile(target: WorkspaceTarget, mutation: WorkspaceFileMutation) = error("not reached")

		override suspend fun fileState(target: WorkspaceTarget, path: String) = error("not reached")
	}

	private class Host(override val workspace: WorkspaceGateway?) : WorkspaceHost {
		override val generation = WorkspaceGeneration()

		override suspend fun send(address: String, text: String) = error("not reached")
	}

	private lateinit var disk: FakeDisk
	private lateinit var host: Host
	private lateinit var ops: WorkspaceFileOps
	private val typing = mutableSetOf<String>()
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")

	private fun view(path: String = "src") = ops.viewOf(one, path) ?: error("no view of $path")

	private fun finished(action: FileAction, result: FileOpResult) = FolderOutcome.Finished(action, result)

	/** Arms as the sheet does. */
	private suspend fun armed(action: ArmedAction): ArmedFileOp {
		ops.begin(one, "src", action)
		return view().confirming ?: error("not armed: ${view().outcome}")
	}

	private suspend fun confirmed(action: ArmedAction): FolderOutcome? {
		armed(action)
		ops.confirm(one, "src")
		return view().outcome
	}

	private suspend fun created(path: String): FolderOutcome? {
		ops.ask(one, "src", PathAsk(PathAsk.Kind.Create, "src"))
		ops.choose(one, "src", CreateFile(path))
		return view().outcome
	}

	@Before
	fun setUp() = runBlocking {
		disk = FakeDisk()
		host = Host(disk)
		ops = WorkspaceFileOps(host) { _, path -> path in typing }
		ops.open(one, "src")
	}

	@Test
	fun `a delete sends what was confirmed, so a file recreated since with the same bytes is left alone`() = runBlocking {
		val delete = ArmedAction.Delete(APP)
		armed(delete)
		disk.table.put(APP, "const x = 1;")
		ops.confirm(one, "src")
		assertEquals(finished(delete, FileOpResult.SourceChanged(gone = false)), view().outcome)

		assertEquals(finished(delete, FileOpResult.Done), confirmed(delete))
		assertNull(disk.table.textOf(APP))

		disk.table.put("src/b.ts", "b")
		val gone = ArmedAction.Delete("src/b.ts")
		armed(gone)
		disk.table.remove("src/b.ts")
		ops.confirm(one, "src")
		assertEquals(finished(gone, FileOpResult.SourceChanged(gone = true)), view().outcome)
	}

	@Test
	fun `a confirmation sends once, a newer arming replaces it, and a re-provision spends it`() = runBlocking {
		armed(ArmedAction.Delete(APP))
		ops.confirm(one, "src")
		ops.confirm(one, "src")
		assertEquals(1, disk.sent.size)

		disk.table.put("src/b.ts", "b")
		armed(ArmedAction.Delete("src/b.ts"))
		assertEquals(finished(ArmedAction.Move("src/b.ts", "lib/b.ts"), FileOpResult.Done), confirmed(ArmedAction.Move("src/b.ts", "lib/b.ts")))
		assertEquals(2, disk.sent.size)

		armed(ArmedAction.Delete("lib/b.ts"))
		host.generation.advance()
		ops.clearInMemory()
		ops.open(one, "src")
		ops.confirm(one, "src")
		assertEquals(2, disk.sent.size)
		assertEquals("b", disk.table.textOf("lib/b.ts"))
	}

	@Test
	fun `an arming in flight across a re-provision draws nothing on the folder opened after it`() = runBlocking {
		val hold = TestHold().also { disk.stateHolds += it }
		val arming = async { ops.begin(one, "src", ArmedAction.Delete(APP)) }
		hold.entered.await()
		host.generation.advance()
		ops.clearInMemory()
		ops.open(one, "src")
		hold.release()
		arming.await()

		assertEquals(FolderView(listing = view().listing), view())
	}

	// A reopened folder is a new showing; the tree it reads is what says what happened.
	@Test
	fun `an op begun in a folder left and reopened lands nothing on the new showing`() = runBlocking {
		val hold = TestHold().also { disk.mutationHolds += it }
		ops.ask(one, "src", PathAsk(PathAsk.Kind.Create, "src"))
		val creating = async { ops.choose(one, "src", CreateFile("src/new.ts")) }
		hold.entered.await()
		ops.leave(one, "src")
		ops.open(one, "src")
		hold.release()
		creating.await()

		assertEquals(FolderView(listing = view().listing), view())
		assertEquals("", disk.table.textOf("src/new.ts"))
	}

	@Test
	fun `a cancelled op lets its folder go, and a confirmation waiting across a re-provision is never sent`() = runBlocking {
		val hold = TestHold().also { disk.mutationHolds += it }
		armed(ArmedAction.Delete(APP))
		val confirming = async { ops.confirm(one, "src") }
		hold.entered.await()
		confirming.cancel()
		hold.release()
		confirming.join()
		assertEquals(false, view().busy)

		disk.table.put("src/b.ts", "b")
		val first = TestHold().also { disk.mutationHolds += it }
		armed(ArmedAction.Delete("src/b.ts"))
		val sending = async { ops.confirm(one, "src") }
		first.entered.await()
		ops.open(one, "lib")
		ops.begin(one, "lib", ArmedAction.Delete("src/b.ts"))
		val waiting = async { ops.confirm(one, "lib") }
		// Lets the second confirm reach the lock the first holds.
		yield()
		assertEquals(true, ops.viewOf(one, "lib")?.busy)
		host.generation.advance()
		ops.clearInMemory()
		first.release()
		sending.await()
		waiting.await()

		assertEquals(listOf("src/b.ts"), disk.sent.filterIsInstance<WorkspaceFileMutation.Delete>().map { it.path })
	}

	@Test
	fun `arming refuses what no precondition can name, and passes on why a path could not be read`() = runBlocking {
		disk.table.put("big.bin", "x")
		disk.tooLarge += "big.bin"
		val refusals = listOf(
			ArmedAction.Delete("src"),
			ArmedAction.Delete("src/missing.ts"),
			ArmedAction.Delete("big.bin"),
			ArmedAction.Move(APP, APP),
			ArmedAction.Move(APP, "lib"),
			ArmedAction.Copy(APP, "big.bin"),
			ArmedAction.Copy(APP, ".env"),
		)
		for (action in refusals) {
			ops.begin(one, "src", action)
			assertTrue("$action", view().outcome is FolderOutcome.NotArmed)
		}
		val withheld = (disk.table.state(".env") as WorkspaceAnswer.Refused).reason
		assertEquals(FolderOutcome.NotArmed(withheld), view().outcome)
		assertTrue(disk.sent.isEmpty())

		val nowhere = WorkspaceFileOps(Host(null)) { _, _ -> false }
		nowhere.open(one, "src")
		nowhere.begin(one, "src", ArmedAction.Delete(APP))
		assertTrue(nowhere.viewOf(one, "src")?.outcome is FolderOutcome.NotArmed)
	}

	@Test
	fun `a move names the destination it found, and replacing one is confirmed as a replace`() = runBlocking {
		val move = ArmedAction.Move(APP, "lib/app.ts")
		assertEquals("Move", confirmOf(armed(move)).button)
		disk.table.put("lib/app.ts", "theirs")
		ops.confirm(one, "src")
		assertEquals(finished(move, FileOpResult.DestinationChanged), view().outcome)
		assertEquals("theirs", disk.table.textOf("lib/app.ts"))

		val identity = disk.table.identityOf(APP)
		assertEquals("Replace", confirmOf(armed(move)).button)
		ops.confirm(one, "src")
		assertEquals(finished(move, FileOpResult.Done), view().outcome)
		assertEquals(identity, disk.table.identityOf("lib/app.ts"))
		assertNull(disk.table.textOf(APP))
	}

	@Test
	fun `an unanswered mutation is settled by reading back, and never sent twice`() = runBlocking {
		disk.lostAfter = true
		val copy = ArmedAction.Copy(APP, "lib/copy.ts")
		val move = ArmedAction.Move(APP, "lib/app.ts")
		val delete = ArmedAction.Delete("lib/copy.ts")
		assertEquals(finished(copy, FileOpResult.Done), confirmed(copy))
		assertEquals(finished(move, FileOpResult.Done), confirmed(move))
		assertEquals(finished(delete, FileOpResult.Done), confirmed(delete))
		assertEquals(3, disk.sent.size)

		val back = ArmedAction.Move("lib/app.ts", APP)
		disk.lostAfter = false
		disk.lostBefore = true
		assertEquals(finished(back, FileOpResult.NotDone(null)), confirmed(back))

		disk.lostBefore = false
		disk.unknown = "timeout: slow"
		assertEquals(finished(back, FileOpResult.NotDone("timeout: slow")), confirmed(back))

		armed(back)
		disk.unreadableAfter = disk.sent.size
		ops.confirm(one, "src")
		assertEquals(finished(back, FileOpResult.Unconfirmed), view().outcome)
		assertEquals(6, disk.sent.size)
	}

	// A move cut short between its link and its unlink leaves both names on one file.
	@Test
	fun `a read back tells a landed copy from a changed destination, and a half-finished move from a done one`() = runBlocking {
		val copy = ArmedAction.Copy(APP, "lib/copy.ts")
		armed(copy)
		disk.unknown = "failed: socket"
		// Landed with its answer lost, then the source was edited.
		disk.table.put("lib/copy.ts", "const x = 1;")
		disk.table.edit(APP, "edited since")
		ops.confirm(one, "src")
		assertEquals(finished(copy, FileOpResult.Done), view().outcome)

		disk.table.remove("lib/copy.ts")
		armed(copy)
		disk.table.put("lib/copy.ts", "someone else's")
		ops.confirm(one, "src")
		assertEquals(finished(copy, FileOpResult.DestinationChanged), view().outcome)

		val move = ArmedAction.Move("lib/copy.ts", "lib/moved.ts")
		armed(move)
		disk.aliases["lib/moved.ts"] = "lib/copy.ts"
		ops.confirm(one, "src")
		assertEquals(finished(move, FileOpResult.Unconfirmed), view().outcome)
	}

	@Test
	fun `a create takes a free name once, opens it, and settles an unanswered one by what is there`() = runBlocking {
		val reads = disk.treeReads
		assertEquals(finished(CreateFile("src/new.ts"), FileOpResult.Done), created("src/new.ts"))
		assertEquals("src/new.ts", view().openRaw)
		assertTrue(disk.treeReads > reads)
		assertTrue((view().listing as WorkspaceAnswer.Read).value.entries.any { it.name == "new.ts" })
		ops.rawOpened(one, "src")
		assertNull(view().openRaw)

		ops.choose(one, "src", CreateFile("src/again.ts"))
		assertNull(disk.table.textOf("src/again.ts"))

		assertEquals(finished(CreateFile(APP), FileOpResult.DestinationChanged), created(APP))
		assertNull(view().openRaw)

		disk.lostAfter = true
		assertEquals(finished(CreateFile("src/lost.ts"), FileOpResult.Done), created("src/lost.ts"))
		disk.lostAfter = false
		disk.lostBefore = true
		assertEquals(finished(CreateFile("src/never.ts"), FileOpResult.NotDone(null)), created("src/never.ts"))
	}

	@Test
	fun `a refused op leaves the tree unread, and a folder left draws and sends nothing`() = runBlocking {
		val reads = disk.treeReads
		val nowhere = ArmedAction.Move(APP, "missing/app.ts")
		armed(nowhere)
		ops.confirm(one, "src")
		assertTrue((view().outcome as FolderOutcome.Finished).result is FileOpResult.Refused)
		assertEquals(reads, disk.treeReads)

		armed(ArmedAction.Delete(APP))
		ops.leave(one, "src")
		ops.confirm(one, "src")
		assertNull(ops.viewOf(one, "src"))
		assertEquals(1, disk.sent.size)
	}

	@Test
	fun `a folder kept open lands a late read, reopens after a re-provision, and leaves when cancelled`() = runBlocking {
		ops.leave(one, "src")
		val late = TestHold().also { disk.treeHolds += it }
		val keeping = launch { ops.keepOpen(one, "src") }
		late.release()
		withTimeout(5_000) { ops.views.first { it[one to "src"]?.listing is WorkspaceAnswer.Read } }

		val reads = disk.treeReads
		host.generation.advance()
		ops.clearInMemory()
		withTimeout(5_000) { ops.views.first { it[one to "src"]?.listing is WorkspaceAnswer.Read } }
		assertEquals(reads + 1, disk.treeReads)

		keeping.cancelAndJoin()
		assertNull(ops.viewOf(one, "src"))
	}

	@Test
	fun `the confirmation names typing the raw editor still holds for the file`() = runBlocking {
		typing += APP

		assertTrue(armed(ArmedAction.Move(APP, "lib/app.ts")).typingHeld)
		assertTrue(confirmOf(armed(ArmedAction.Delete(APP))).lines.isNotEmpty())
		assertTrue(confirmOf(armed(ArmedAction.Copy(APP, "lib/app.ts"))).lines.isEmpty())
	}

	@Test
	fun `a typed path is trimmed, and a trailing slash keeps the name it had`() {
		val move = PathAsk(PathAsk.Kind.Move, APP)
		assertEquals(ArmedAction.Move(APP, "lib/app.ts"), move.actionOf(" lib/ "))
		assertEquals(ArmedAction.Move(APP, "lib/b.ts"), move.actionOf("/lib/b.ts"))
		assertNull(move.actionOf("  "))

		val create = PathAsk(PathAsk.Kind.Create, "src")
		assertNull(create.actionOf(create.prefill))
		assertEquals(CreateFile("src/new.ts"), create.actionOf("${create.prefill}new.ts"))
	}
}
