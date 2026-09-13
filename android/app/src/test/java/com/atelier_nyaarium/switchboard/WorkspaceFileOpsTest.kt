package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileDestination
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private fun hashOf(text: String) = "h:${text.hashCode()}"

class WorkspaceFileOpsTest {
	/** Files by path, each on its own inode, mutated only while every precondition holds, as the plugin does. */
	private class FakeDisk : WorkspaceGateway by NotReached {
		data class Entry(val text: String, val inode: Long)

		val files = mutableMapOf<String, Entry>()
		val folders = mutableSetOf("src", "lib")
		val tooLarge = mutableSetOf<String>()
		val withheld = mutableSetOf<String>()
		val sent = mutableListOf<WorkspaceFileMutation>()

		/** Applies, then answers nothing. */
		var lostAfter = false

		/** Answers nothing, and applies nothing. */
		var lostBefore = false

		/** Applies nothing, and answers `unknown` with this reason. */
		var unknown: String? = null

		/** State reads fail once more than this many mutations were sent. */
		var unreadableAfter: Int? = null

		private var inodes = 0L

		fun put(path: String, text: String) {
			files[path] = Entry(text, ++inodes)
		}

		override suspend fun fileState(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceFileStateAnswer> {
			if (unreadableAfter?.let { sent.size > it } == true) return WorkspaceAnswer.Unreachable
			if (path in withheld) return WorkspaceAnswer.Refused("$path is withheld")
			val entry = files[path]
			return WorkspaceAnswer.Read(
				when {
					path in folders -> WorkspaceFileStateAnswer(path = path, state = "directory")
					entry == null -> WorkspaceFileStateAnswer(path = path, state = "absent")
					path in tooLarge -> WorkspaceFileStateAnswer(path = path, state = "file", bytes = 1L shl 30)
					else -> WorkspaceFileStateAnswer(
						path = path,
						state = "file",
						bytes = entry.text.length.toLong(),
						hash = hashOf(entry.text),
						identity = "i${entry.inode}",
					)
				},
			)
		}

		private fun holds(path: String, hash: String, identity: String?) =
			files[path]?.let { hashOf(it.text) == hash && (identity == null || "i${it.inode}" == identity) } == true

		private fun lands(to: String, destination: WorkspaceFileDestination) =
			when (destination) {
				WorkspaceFileDestination.Absent -> to !in files
				is WorkspaceFileDestination.Replace -> holds(to, destination.expectedHash, destination.expectedIdentity)
			}

		override suspend fun mutateFile(
			target: WorkspaceTarget,
			mutation: WorkspaceFileMutation,
		): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
			sent += mutation
			val path = when (mutation) {
				is WorkspaceFileMutation.Create -> mutation.path
				is WorkspaceFileMutation.Delete -> mutation.path
				is WorkspaceFileMutation.Move -> mutation.path
				is WorkspaceFileMutation.Copy -> mutation.path
				is WorkspaceFileMutation.Write -> error("not reached")
			}
			if (lostBefore) return WorkspaceAnswer.Unreachable
			unknown?.let { return WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = path, outcome = "unknown", reason = it)) }
			val outcome = apply(mutation)
			if (lostAfter) return WorkspaceAnswer.Unreachable
			return WorkspaceAnswer.Read(
				WorkspaceFileMutationAnswer(path = path, outcome = outcome, gone = (path !in files).takeIf { outcome == MUTATION_STALE }),
			)
		}

		private fun apply(mutation: WorkspaceFileMutation): String =
			when (mutation) {
				is WorkspaceFileMutation.Create ->
					if (mutation.path in files) MUTATION_DESTINATION_CHANGED else MUTATION_DONE.also { put(mutation.path, mutation.text) }
				is WorkspaceFileMutation.Delete ->
					if (!holds(mutation.path, mutation.expectedHash, mutation.expectedIdentity)) {
						MUTATION_STALE
					} else {
						MUTATION_DONE.also { files.remove(mutation.path) }
					}
				is WorkspaceFileMutation.Move -> when {
					!holds(mutation.path, mutation.expectedHash, mutation.expectedIdentity) -> MUTATION_STALE
					!lands(mutation.to, mutation.destination) -> MUTATION_DESTINATION_CHANGED
					else -> MUTATION_DONE.also { files[mutation.to] = files.remove(mutation.path)!! }
				}
				is WorkspaceFileMutation.Copy -> when {
					!holds(mutation.path, mutation.expectedHash, null) -> MUTATION_STALE
					!lands(mutation.to, mutation.destination) -> MUTATION_DESTINATION_CHANGED
					else -> MUTATION_DONE.also { put(mutation.to, files.getValue(mutation.path).text) }
				}
				is WorkspaceFileMutation.Write -> error("not reached")
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
		override suspend fun send(address: String, text: String) = error("not reached")
	}

	private lateinit var disk: FakeDisk
	private lateinit var ops: WorkspaceFileOps
	private val typing = mutableSetOf<String>()
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")

	private suspend fun armed(action: ArmedAction): ArmedFileOp {
		val arming = ops.arm(one, action)
		return (arming as? Arming.Armed)?.op ?: error("not armed: $arming")
	}

	@Before
	fun setUp() {
		disk = FakeDisk()
		disk.put("src/app.ts", "const x = 1;")
		ops = WorkspaceFileOps(Host(disk)) { _, path -> path in typing }
	}

	@Test
	fun `a delete sends what was confirmed, so a file recreated since with the same bytes is left alone`() = runBlocking {
		val op = armed(ArmedAction.Delete("src/app.ts"))
		disk.put("src/app.ts", "const x = 1;")

		assertEquals(FileOpResult.SourceChanged(gone = false), ops.perform(one, op))
		assertTrue("src/app.ts" in disk.files)

		assertEquals(FileOpResult.Done, ops.perform(one, armed(ArmedAction.Delete("src/app.ts"))))
		assertFalse("src/app.ts" in disk.files)

		disk.put("src/b.ts", "b")
		val gone = armed(ArmedAction.Delete("src/b.ts"))
		disk.files.remove("src/b.ts")
		assertEquals(FileOpResult.SourceChanged(gone = true), ops.perform(one, gone))
	}

	@Test
	fun `a confirmation sends once, and a newer arming or a re-provision spends it`() = runBlocking {
		val op = armed(ArmedAction.Delete("src/app.ts"))
		assertEquals(FileOpResult.Done, ops.perform(one, op))
		assertTrue(ops.perform(one, op) is FileOpResult.Refused)

		disk.put("src/b.ts", "b")
		val older = armed(ArmedAction.Delete("src/b.ts"))
		armed(ArmedAction.Move("src/b.ts", "lib/b.ts"))
		assertTrue(ops.perform(one, older) is FileOpResult.Refused)

		val beforeReprovision = armed(ArmedAction.Delete("src/b.ts"))
		ops.clearInMemory()
		assertTrue(ops.perform(one, beforeReprovision) is FileOpResult.Refused)

		assertEquals(1, disk.sent.size)
		assertTrue("src/b.ts" in disk.files)
	}

	@Test
	fun `arming refuses what no precondition can name, and passes on why a path could not be read`() = runBlocking {
		disk.put("big.bin", "x")
		disk.tooLarge += "big.bin"
		disk.withheld += ".env"
		val refusals = listOf(
			ArmedAction.Delete("src"),
			ArmedAction.Delete("src/missing.ts"),
			ArmedAction.Delete("big.bin"),
			ArmedAction.Move("src/app.ts", "src/app.ts"),
			ArmedAction.Move("src/app.ts", "lib"),
			ArmedAction.Copy("src/app.ts", "big.bin"),
			ArmedAction.Copy("src/app.ts", ".env"),
		)
		for (action in refusals) assertTrue("$action", ops.arm(one, action) is Arming.Refused)
		assertEquals(Arming.Refused(".env is withheld"), ops.arm(one, ArmedAction.Copy("src/app.ts", ".env")))

		val nowhere = WorkspaceFileOps(Host(null)) { _, _ -> false }
		assertTrue(nowhere.arm(one, ArmedAction.Delete("src/app.ts")) is Arming.Refused)
		assertTrue(disk.sent.isEmpty())
	}

	@Test
	fun `a move names the destination it found, and replacing one is confirmed as a replace`() = runBlocking {
		val toFree = armed(ArmedAction.Move("src/app.ts", "lib/app.ts"))
		assertEquals("Move", confirmOf(toFree).button)
		disk.put("lib/app.ts", "theirs")

		assertEquals(FileOpResult.DestinationChanged, ops.perform(one, toFree))
		assertEquals("theirs", disk.files.getValue("lib/app.ts").text)
		assertTrue("src/app.ts" in disk.files)

		val inode = disk.files.getValue("src/app.ts").inode
		val over = armed(ArmedAction.Move("src/app.ts", "lib/app.ts"))
		assertEquals("Replace", confirmOf(over).button)

		assertEquals(FileOpResult.Done, ops.perform(one, over))
		assertEquals(FakeDisk.Entry("const x = 1;", inode), disk.files["lib/app.ts"])
		assertFalse("src/app.ts" in disk.files)
	}

	@Test
	fun `an unanswered mutation is settled by reading back, and never sent twice`() = runBlocking {
		disk.lostAfter = true
		assertEquals(FileOpResult.Done, ops.perform(one, armed(ArmedAction.Copy("src/app.ts", "lib/copy.ts"))))
		assertEquals(FileOpResult.Done, ops.perform(one, armed(ArmedAction.Move("src/app.ts", "lib/app.ts"))))
		assertEquals(FileOpResult.Done, ops.perform(one, armed(ArmedAction.Delete("lib/copy.ts"))))
		assertEquals(3, disk.sent.size)

		val back = ArmedAction.Move("lib/app.ts", "src/app.ts")
		disk.lostAfter = false
		disk.lostBefore = true
		assertEquals(FileOpResult.NotDone(null), ops.perform(one, armed(back)))

		disk.lostBefore = false
		disk.unknown = "timeout: slow"
		assertEquals(FileOpResult.NotDone("timeout: slow"), ops.perform(one, armed(back)))

		val move = armed(back)
		disk.unreadableAfter = disk.sent.size
		assertEquals(FileOpResult.Unconfirmed, ops.perform(one, move))
		assertEquals(6, disk.sent.size)
	}

	// A move cut short between its link and its unlink leaves both names on one inode.
	@Test
	fun `a read back tells a landed copy from a changed destination, and a half-finished move from a done one`() = runBlocking {
		val copy = armed(ArmedAction.Copy("src/app.ts", "lib/copy.ts"))
		disk.unknown = "failed: socket"
		// What landing looks like when the answer is lost, followed by an edit to the source.
		disk.put("lib/copy.ts", "const x = 1;")
		disk.put("src/app.ts", "edited since")
		assertEquals(FileOpResult.Done, ops.perform(one, copy))

		disk.files.remove("lib/copy.ts")
		val again = armed(ArmedAction.Copy("src/app.ts", "lib/copy.ts"))
		disk.put("lib/copy.ts", "someone else's")
		assertEquals(FileOpResult.DestinationChanged, ops.perform(one, again))

		val move = armed(ArmedAction.Move("lib/copy.ts", "lib/moved.ts"))
		disk.files["lib/moved.ts"] = disk.files.getValue("lib/copy.ts")
		assertEquals(FileOpResult.Unconfirmed, ops.perform(one, move))
	}

	@Test
	fun `a create takes only a free name, and an unanswered one is settled by what is there`() = runBlocking {
		assertEquals(FileOpResult.Done, ops.create(one, "src/new.ts"))
		assertEquals(FileOpResult.DestinationChanged, ops.create(one, "src/app.ts"))

		disk.lostAfter = true
		assertEquals(FileOpResult.Done, ops.create(one, "src/lost.ts"))
		disk.lostAfter = false
		disk.lostBefore = true
		assertEquals(FileOpResult.NotDone(null), ops.create(one, "src/never.ts"))
		assertEquals(FileOpResult.DestinationChanged, ops.create(one, "src/app.ts"))
		assertEquals("", disk.files.getValue("src/lost.ts").text)

		assertEquals("src/new.ts", rawToOpen(CreateFile("src/new.ts"), FileOpResult.Done))
		assertNull(rawToOpen(CreateFile("src/app.ts"), FileOpResult.DestinationChanged))
		assertNull(rawToOpen(ArmedAction.Delete("src/app.ts"), FileOpResult.Done))
	}

	@Test
	fun `the confirmation names typing the raw editor still holds for the file`() = runBlocking {
		typing += "src/app.ts"

		assertTrue(armed(ArmedAction.Move("src/app.ts", "lib/app.ts")).typingHeld)
		assertTrue(confirmOf(armed(ArmedAction.Delete("src/app.ts"))).lines.isNotEmpty())
		assertTrue(confirmOf(armed(ArmedAction.Copy("src/app.ts", "lib/app.ts"))).lines.isEmpty())
	}

	@Test
	fun `a typed path is trimmed, and a trailing slash keeps the name it had`() {
		val move = PathAsk(PathAsk.Kind.Move, "src/app.ts")
		assertEquals(ArmedAction.Move("src/app.ts", "lib/app.ts"), move.actionOf(" lib/ "))
		assertEquals(ArmedAction.Move("src/app.ts", "lib/b.ts"), move.actionOf("/lib/b.ts"))
		assertNull(move.actionOf("  "))

		val create = PathAsk(PathAsk.Kind.Create, "src")
		assertNull(create.actionOf(create.prefill))
		assertEquals(CreateFile("src/new.ts"), create.actionOf("${create.prefill}new.ts"))
	}
}
