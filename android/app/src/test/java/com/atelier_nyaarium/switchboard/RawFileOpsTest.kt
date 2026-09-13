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
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private const val PATH = "src/app.ts"

private fun hashOf(text: String) = "h:${text.hashCode()}"

class RawFileOpsTest {
	/** Files by path, written only while the hash matches, as the plugin does. */
	private class FakeFiles : WorkspaceGateway {
		val files = mutableMapOf(PATH to "const x = 1;")
		val readOnly = mutableSetOf<String>()

		/** `lost` writes and answers nothing; `unreadable` fails every read after a write. */
		var lost = false
		var unreadable = false
		val writeHolds = mutableListOf<TestHold>()
		val readHolds = mutableListOf<TestHold>()
		val writes = mutableListOf<String>()

		override suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> {
			// Answered before the hold, so a held answer is wholly the older one.
			val text = files[path]
			val answer = when {
				unreadable -> WorkspaceAnswer.Unreachable
				text == null -> WorkspaceAnswer.Refused("$path does not exist")
				path in readOnly -> WorkspaceAnswer.Read(
					WorkspaceReadAnswer(path = path, text = text, lines = text.lines().size.toLong(), readOnly = "too large"),
				)
				else -> WorkspaceAnswer.Read(
					WorkspaceReadAnswer(path = path, text = text, lines = text.lines().size.toLong(), hash = hashOf(text)),
				)
			}
			readHolds.removeFirstOrNull()?.pass()
			return answer
		}

		override suspend fun mutateFile(
			target: WorkspaceTarget,
			mutation: WorkspaceFileMutation,
		): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
			val write = mutation as WorkspaceFileMutation.Write
			writeHolds.removeFirstOrNull()?.pass()
			val current = files[write.path]
				?: return WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = write.path, outcome = MUTATION_STALE, gone = true))
			if (hashOf(current) != write.expectedHash) {
				return WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = write.path, outcome = MUTATION_STALE))
			}
			files[write.path] = write.text
			writes += write.text
			if (lost) return WorkspaceAnswer.Unreachable
			return WorkspaceAnswer.Read(
				WorkspaceFileMutationAnswer(path = write.path, outcome = MUTATION_DONE, hash = hashOf(write.text)),
			)
		}

		override suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer> =
			error("not reached")

		override suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer> =
			error("not reached")

		override suspend fun symbolSource(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceSymbolSourceAnswer> =
			error("not reached")

		override suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer> =
			error("not reached")

		override suspend fun saveSpan(
			target: WorkspaceTarget,
			symbolId: String,
			expectedSpanHash: String,
			text: String,
		): WorkspaceAnswer<WorkspaceSaveSpanAnswer> = error("not reached")
	}

	private class Host(override val workspace: WorkspaceGateway?) : WorkspaceHost {
		override suspend fun send(address: String, text: String) = error("not reached")
	}

	private lateinit var dir: File
	private lateinit var files: FakeFiles
	private lateinit var ops: RawFileOps
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")

	private fun opsOver(over: File = dir, gateway: WorkspaceGateway? = files) =
		RawFileOps(Host(gateway), WorkspaceDraftStore(over, CoroutineScope(Dispatchers.Unconfined)))

	private fun edit(held: RawFileOps = ops) = held.editOf(one, PATH)

	@Before
	fun setUp() {
		dir = Files.createTempDirectory("raw-files-").toFile()
		files = FakeFiles()
		ops = opsOver()
	}

	@After
	fun tearDown() {
		dir.deleteRecursively()
	}

	@Test
	fun `a save writes over what was read, and the file becomes what is held`() = runBlocking {
		assertEquals(RawView.Editable, ops.open(one, PATH))
		// The field reports a caret move as the same text, which drafts nothing.
		ops.type(one, PATH, "const x = 1;")
		assertNull(edit()!!.draft)
		ops.type(one, PATH, "const x = 2;")

		assertEquals(RawSave.Written, ops.save(one, PATH))

		assertEquals("const x = 2;", files.files[PATH])
		assertEquals(Triple("const x = 2;", hashOf("const x = 2;"), false), edit()!!.let { Triple(it.original, it.hash, it.edited) })
		ops.leave(one, PATH)
		assertNull(edit())
		assertNull(edit(opsOverAfterOpen())?.draft)
	}

	private suspend fun opsOverAfterOpen() = opsOver().also { it.open(one, PATH) }

	@Test
	fun `a file that cannot be written opens read-only and holds nothing`() = runBlocking {
		files.readOnly += PATH

		assertEquals(RawView.ReadOnly("const x = 1;", "too large"), ops.open(one, PATH))
		assertEquals(RawView.ReadOnly("const x = 1;", "too large"), ops.viewOf(one, PATH))
		assertNull(edit())
	}

	@Test
	fun `typing outlives leaving the screen and the process, and nothing typed lets go`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		ops.leave(one, PATH)
		assertEquals("const x = 2;", edit()?.shown)

		val restarted = opsOver()
		restarted.open(one, PATH)
		assertEquals("const x = 2;", edit(restarted)?.shown)

		restarted.discard(one, PATH)
		restarted.leave(one, PATH)
		assertNull(edit(restarted))
		assertNull(opsOverAfterOpen().let { edit(it)?.draft })
	}

	@Test
	fun `typing reopened over a file that moved comes back stale, and its save writes nothing`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		files.files[PATH] = "const x = 3;"

		val restarted = opsOver()
		restarted.open(one, PATH)

		assertTrue(edit(restarted)!!.stale)
		assertEquals(RawSave.Stale(gone = false), restarted.save(one, PATH))
		assertEquals("const x = 3;", files.files[PATH])
		assertEquals("const x = 2;", edit(restarted)?.shown)
	}

	@Test
	fun `a save over a moved file keeps the typing, and Refresh takes the file instead`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		files.files[PATH] = "const x = 3;"

		assertEquals(RawSave.Stale(gone = false), ops.save(one, PATH))
		assertEquals(true to "const x = 2;", edit()!!.stale to edit()!!.shown)

		assertNull(ops.adopt(one, PATH))
		assertEquals(false to "const x = 3;", edit()!!.stale to edit()!!.shown)
		assertFalse(edit()!!.edited)
	}

	// Losing the editor to a notice would hide the typing the banner is protecting.
	@Test
	fun `Refresh that cannot read says so and leaves the editor and its typing`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		files.unreadable = true

		assertEquals("This session could not be reached", ops.adopt(one, PATH))
		assertEquals(RawView.Editable, ops.viewOf(one, PATH))
		assertEquals("const x = 2;", edit()?.shown)
	}

	@Test
	fun `Refresh onto a file that can no longer be written lets it go and shows it read-only`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		files.files[PATH] = "huge"
		files.readOnly += PATH

		assertNull(ops.adopt(one, PATH))
		assertEquals(RawView.ReadOnly("huge", "too large"), ops.viewOf(one, PATH))
		assertNull(edit())
		assertNull(opsOverAfterOpen().let { edit(it) })
	}

	@Test
	fun `a write whose answer never came is settled by reading the file back`() = runBlocking {
		files.lost = true
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		assertEquals(RawSave.Written, ops.save(one, PATH))
		assertFalse(edit()!!.edited)

		files.unreadable = true
		ops.type(one, PATH, "const x = 4;")
		assertEquals(RawSave.Unconfirmed, ops.save(one, PATH))
	}

	@Test
	fun `an unknown write that read back unchanged is not written, and one that read back moved is stale`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		val nowhere = RawFileOps(Host(object : WorkspaceGateway by files {
			override suspend fun mutateFile(target: WorkspaceTarget, mutation: WorkspaceFileMutation) =
				WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = PATH, outcome = "unknown", reason = "timeout: slow"))
		}), WorkspaceDraftStore(dir, CoroutineScope(Dispatchers.Unconfined)))
		nowhere.open(one, PATH)

		assertEquals(RawSave.NotWritten("timeout: slow"), nowhere.save(one, PATH))
		assertEquals("const x = 2;", edit(nowhere)?.shown)

		files.files[PATH] = "const x = 9;"
		assertEquals(RawSave.Stale(gone = false), nowhere.save(one, PATH))
		assertEquals(true to "const x = 2;", edit(nowhere)!!.stale to edit(nowhere)!!.shown)
	}

	@Test
	fun `typing during a save stays a draft over the saved text`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		val hold = TestHold().also { files.writeHolds += it }

		val saving = async(Dispatchers.Default) { ops.save(one, PATH) }
		hold.entered.await()
		ops.type(one, PATH, "const x = 2; // more")
		hold.release()

		assertEquals(RawSave.Written, saving.await())
		assertEquals("const x = 2;" to "const x = 2; // more", edit()!!.original to edit()!!.shown)
	}

	// The read began before the save landed, so it describes a version the edit has moved past.
	@Test
	fun `a recheck read before a save landed does not put the old text back`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		val hold = TestHold().also { files.readHolds += it }

		val sweeping = async(Dispatchers.Default) { ops.recheck(one) }
		hold.entered.await()
		ops.save(one, PATH)
		hold.release()
		sweeping.await()

		assertEquals("const x = 2;" to false, edit()!!.shown to edit()!!.stale)
	}

	@Test
	fun `a recheck adopts a moved file with nothing typed, and flags one with typing`() = runBlocking {
		ops.open(one, PATH)
		files.files[PATH] = "const x = 3;"
		ops.recheck(one)
		assertEquals(false to "const x = 3;", edit()!!.stale to edit()!!.shown)

		ops.type(one, PATH, "mine")
		files.files[PATH] = "const x = 4;"
		ops.recheck(one)
		assertEquals(true to "mine", edit()!!.stale to edit()!!.shown)
	}

	@Test
	fun `a held file that can no longer be written is let go with nothing typed, and flagged with typing`() = runBlocking {
		ops.open(one, PATH)
		files.files[PATH] = "huge"
		files.readOnly += PATH

		ops.recheck(one)
		assertNull(edit())
		assertEquals(RawView.ReadOnly("huge", "too large"), ops.viewOf(one, PATH))

		files.readOnly -= PATH
		ops.open(one, PATH)
		ops.type(one, PATH, "mine")
		files.readOnly += PATH
		files.files[PATH] = "huger"

		assertEquals(RawView.Editable, ops.open(one, PATH))
		assertEquals(true to "mine", edit()!!.stale to edit()!!.shown)
	}

	@Test
	fun `typing while a Refresh reads outranks it`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		files.files[PATH] = "const x = 3;"
		val hold = TestHold().also { files.readHolds += it }

		val adopting = async(Dispatchers.Default) { ops.adopt(one, PATH) }
		hold.entered.await()
		ops.type(one, PATH, "const x = 2; // more")
		hold.release()
		adopting.await()

		assertEquals("const x = 2; // more", edit()?.shown)
	}

	@Test
	fun `reopening held typing while the file cannot be read still draws the editor`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "const x = 2;")
		ops.leave(one, PATH)
		files.unreadable = true

		assertEquals(RawView.Editable, ops.open(one, PATH))
		assertEquals("const x = 2;", edit()?.shown)
	}

	@Test
	fun `of two opens of one path, the older answer lands nothing`() = runBlocking {
		files.readOnly += PATH
		val hold = TestHold().also { files.readHolds += it }
		val older = async(Dispatchers.Default) { ops.open(one, PATH) }
		hold.entered.await()

		files.readOnly -= PATH
		assertEquals(RawView.Editable, ops.open(one, PATH))
		hold.release()
		older.await()

		assertEquals(RawView.Editable, ops.viewOf(one, PATH))
		assertEquals("const x = 1;", edit()?.shown)
	}

	@Test
	fun `leaving while the open still reads holds nothing once it answers`() = runBlocking {
		val hold = TestHold().also { files.readHolds += it }

		val opening = async(Dispatchers.Default) { ops.open(one, PATH) }
		hold.entered.await()
		ops.leave(one, PATH)
		hold.release()
		opening.await()

		assertNull(edit())
		assertNull(ops.viewOf(one, PATH))
	}

	// Remove 2026-09-26, with `UNKNOWN_BASE`.
	@Test
	fun `typing from before bases were kept, reopened over a moved file, is stale and its save writes nothing`() =
		runBlocking {
			val name = separated(separated(one.key, "file"), PATH)
			val legacy = MessageDigest.getInstance("SHA-256").digest(name.toByteArray()).joinToString("") { "%02x".format(it) }
			File(dir, legacy).writeText("const x = 0; // old typing")
			files.files[PATH] = "const x = 3;"

			ops.open(one, PATH)

			assertTrue(edit()!!.stale)
			assertEquals(RawSave.Stale(gone = false), ops.save(one, PATH))
			assertEquals("const x = 3;", files.files[PATH])
		}

	@Test
	fun `a re-provision lets every file go, typing included`() = runBlocking {
		ops.open(one, PATH)
		ops.type(one, PATH, "mine")

		ops.clearInMemory()

		assertNull(edit())
		assertNull(ops.viewOf(one, PATH))
		assertNull(opsOverAfterOpen().let { edit(it)?.draft })
	}
}
