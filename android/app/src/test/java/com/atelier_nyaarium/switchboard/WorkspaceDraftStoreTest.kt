package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private val F_ID = DraftKey.Span("lexicon typescript src/a.ts f().")
private val G_ID = DraftKey.Span("lexicon typescript src/a.ts g().")

private fun typed(text: String) = HeldDraft(base = "h1", text = text)

/** Hands dispatched work back newest first. */
private class ReversingDispatcher : CoroutineDispatcher() {
	private val held = ArrayDeque<Runnable>()

	override fun dispatch(context: CoroutineContext, block: Runnable) {
		held.addLast(block)
	}

	fun drain() {
		while (held.isNotEmpty()) held.removeLast().run()
	}
}

class WorkspaceDraftStoreTest {
	private lateinit var dir: File
	private lateinit var store: WorkspaceDraftStore
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")
	private val two = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.bbb")

	private fun storeOver(over: File) = WorkspaceDraftStore(over, CoroutineScope(Dispatchers.Unconfined))

	private suspend fun textOf(key: DraftKey, target: WorkspaceTarget = one) = store.load(target, key)?.text

	@Before
	fun setUp() {
		dir = Files.createTempDirectory("window-drafts-").toFile()
		store = storeOver(dir)
	}

	@After
	fun tearDown() {
		dir.deleteRecursively()
	}

	@Test
	fun `a draft and the hash it was typed over survive being reloaded`() = runBlocking {
		store.save(one, F_ID, HeldDraft(base = "h1", text = "half a sentence\nand a second line"))

		assertEquals(HeldDraft(base = "h1", text = "half a sentence\nand a second line"), storeOver(dir).load(one, F_ID))
	}

	@Test
	fun `an absent draft reads as nothing rather than empty`() = runBlocking {
		assertNull(store.load(one, F_ID))
	}

	@Test
	fun `a saved empty draft is kept apart from no draft`() = runBlocking {
		store.save(one, F_ID, typed(""))

		assertEquals("", textOf(F_ID))
	}

	@Test
	fun `sessions, symbols and whole files each keep their own draft`() = runBlocking {
		val file = DraftKey.File("src/a.ts")
		store.save(one, F_ID, typed("for f"))
		store.save(one, G_ID, typed("for g"))
		store.save(two, F_ID, typed("theirs"))
		store.save(one, file, typed("the whole file"))

		assertEquals("for f", textOf(F_ID))
		assertEquals("for g", textOf(G_ID))
		assertEquals("theirs", textOf(F_ID, two))
		assertEquals("the whole file", textOf(file))
		assertNull(textOf(DraftKey.Span("src/a.ts")))
	}

	@Test
	fun `a resave replaces rather than appends`() = runBlocking {
		store.save(one, F_ID, typed("first"))
		store.save(one, F_ID, HeldDraft(base = "h2", text = "second"))

		assertEquals(HeldDraft(base = "h2", text = "second"), store.load(one, F_ID))
	}

	@Test
	fun `clearing one draft leaves the others`() = runBlocking {
		store.save(one, F_ID, typed("for f"))
		store.save(one, G_ID, typed("for g"))

		store.clear(one, F_ID)

		assertNull(store.load(one, F_ID))
		assertEquals("for g", textOf(G_ID))
	}

	// Reordered by construction, not by timing.
	@Test
	fun `a save and a clear land in the order they were asked for, not the dispatcher's`() {
		val reversing = ReversingDispatcher()
		val reordered = WorkspaceDraftStore(dir, CoroutineScope(reversing))

		reordered.save(one, F_ID, typed("typed"))
		reordered.save(one, G_ID, typed("kept"))
		reordered.clear(one, F_ID)
		reordered.save(one, G_ID, typed("kept, then more"))
		reversing.drain()

		assertEquals(
			listOf("kept, then more"),
			runBlocking { listOf(F_ID, G_ID).mapNotNull { storeOver(dir).load(one, it)?.text } },
		)
	}

	// One file per draft is the whole point: typing in one span must not rewrite another.
	@Test
	fun `each draft is its own file`() = runBlocking {
		store.save(one, F_ID, typed("for f"))
		store.save(one, G_ID, typed("for g"))

		assertEquals("for g", textOf(G_ID))
		assertEquals(2, dir.listFiles()?.count { it.isFile })
	}

	@Test
	fun `a file of real size round-trips`() = runBlocking {
		val big = "fun f() {}\n".repeat(20_000)

		store.save(one, DraftKey.File("src/a.ts"), typed(big))

		assertEquals(big, textOf(DraftKey.File("src/a.ts")))
	}

	// A symbol id is not a filename, so the key must be hashed rather than spelled.
	@Test
	fun `a symbol id with separators in it still names one file`() = runBlocking {
		val awkward = DraftKey.Span("lexicon typescript src/deep/a b.ts Thing#method(x).")

		store.save(one, awkward, typed("held"))

		assertEquals("held", textOf(awkward))
		assertNotEquals(0, dir.listFiles()?.size)
	}

	// Remove 2026-09-26, with the legacy read.
	@Test
	fun `a draft written before bases were kept reads with a base no hash equals, and a clear takes it`() = runBlocking {
		val name = separated(one.key, "lexicon typescript src/a.ts f().")
		val legacy = MessageDigest.getInstance("SHA-256").digest(name.toByteArray()).joinToString("") { "%02x".format(it) }
		File(dir, legacy).writeText("older typing")

		assertEquals(HeldDraft(base = UNKNOWN_BASE, text = "older typing"), store.load(one, F_ID))

		store.clear(one, F_ID)

		assertNull(store.load(one, F_ID))
		assertFalse(File(dir, legacy).exists())
	}

	// The failure itself only reaches the log, which no gate here reads. What is pinned is that a write
	// that could not land leaves the previous draft and no half file behind.
	@Test
	fun `a save onto an unusable directory keeps the previous draft and leaves no part file`() = runBlocking {
		store.save(one, F_ID, typed("landed"))
		assertEquals("landed", textOf(F_ID))

		val occupied = File(dir, "occupied").apply { writeText("a file, not a directory") }
		val blocked = storeOver(File(occupied, "drafts"))
		blocked.save(one, F_ID, typed("never lands"))

		assertNull(blocked.load(one, F_ID))
		assertEquals("landed", textOf(F_ID))
		assertEquals(0, dir.listFiles()?.count { it.name.endsWith(".part") })
	}

	// One throwing job must leave the worker alive. A dead one is not silent: everything after it runs
	// on the caller instead, which for a keystroke is the main thread.
	@Test
	fun `a job that throws leaves the worker serving, so later work is still queued`() {
		val reversing = ReversingDispatcher()
		val occupied = File(dir, "occupied").apply { writeText("a file, not a directory") }
		val under = File(occupied, "drafts")
		val store = WorkspaceDraftStore(under, CoroutineScope(reversing))

		store.save(one, F_ID, typed("doomed"))
		reversing.drain()
		occupied.delete()
		store.save(one, F_ID, typed("after"))

		assertFalse(under.exists())
		reversing.drain()
		assertTrue(under.isDirectory)
	}

	// A cancelled scope leaves the queue with no worker.
	@Test
	fun `a read after the scope is cancelled still answers`() = runBlocking {
		val scope = CoroutineScope(Dispatchers.Unconfined)
		val abandoned = WorkspaceDraftStore(dir, scope)
		abandoned.save(one, F_ID, typed("before the cancel"))

		scope.cancel()

		withTimeout(5_000) { assertEquals("before the cancel", abandoned.load(one, F_ID)?.text) }
	}

	@Test
	fun `a re-provision takes every draft`() = runBlocking {
		store.save(one, F_ID, typed("mine"))
		store.save(two, DraftKey.File("src/a.ts"), typed("theirs"))

		store.clearAll()

		assertNull(store.load(one, F_ID))
		assertNull(store.load(two, DraftKey.File("src/a.ts")))
	}
}
