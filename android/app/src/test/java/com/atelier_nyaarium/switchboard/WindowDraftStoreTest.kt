package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
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

private const val F_ID = "lexicon typescript src/a.ts f()."
private const val G_ID = "lexicon typescript src/a.ts g()."

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

class WindowDraftStoreTest {
	private lateinit var dir: File
	private lateinit var store: WindowDraftStore
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")
	private val two = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.bbb")

	private fun storeOver(over: File) = WindowDraftStore(over, CoroutineScope(Dispatchers.Unconfined))

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
	fun `a draft survives being reloaded`() = runBlocking {
		store.save(one, F_ID, "half a sentence")

		assertEquals("half a sentence", storeOver(dir).load(one, F_ID))
	}

	@Test
	fun `an absent draft reads as nothing rather than empty`() = runBlocking {
		assertNull(store.load(one, F_ID))
	}

	@Test
	fun `a saved empty draft is kept apart from no draft`() = runBlocking {
		store.save(one, F_ID, "")

		assertEquals("", store.load(one, F_ID))
	}

	@Test
	fun `two sessions of one gateway keep separate drafts`() = runBlocking {
		store.save(one, F_ID, "mine")
		store.save(two, F_ID, "theirs")

		assertEquals("mine", store.load(one, F_ID))
		assertEquals("theirs", store.load(two, F_ID))
	}

	@Test
	fun `two symbols of one session keep separate drafts`() = runBlocking {
		store.save(one, F_ID, "for f")
		store.save(one, G_ID, "for g")

		assertEquals("for f", store.load(one, F_ID))
		assertEquals("for g", store.load(one, G_ID))
	}

	@Test
	fun `a resave replaces rather than appends`() = runBlocking {
		store.save(one, F_ID, "first")
		store.save(one, F_ID, "second")

		assertEquals("second", store.load(one, F_ID))
	}

	@Test
	fun `clearing one draft leaves the others`() = runBlocking {
		store.save(one, F_ID, "for f")
		store.save(one, G_ID, "for g")

		store.clear(one, F_ID)

		assertNull(store.load(one, F_ID))
		assertEquals("for g", store.load(one, G_ID))
	}

	// Reordered by construction, not by timing.
	@Test
	fun `a save and a clear land in the order they were asked for, not the dispatcher's`() {
		val reversing = ReversingDispatcher()
		val reordered = WindowDraftStore(dir, CoroutineScope(reversing))

		reordered.save(one, F_ID, "typed")
		reordered.save(one, G_ID, "kept")
		reordered.clear(one, F_ID)
		reversing.drain()

		assertEquals(listOf("kept"), runBlocking { listOf(F_ID, G_ID).mapNotNull { storeOver(dir).load(one, it) } })
	}

	// One file per draft is the whole point: typing in one span must not rewrite another.
	@Test
	fun `each draft is its own file`() = runBlocking {
		store.save(one, F_ID, "for f")
		store.save(one, G_ID, "for g")

		assertEquals("for g", store.load(one, G_ID))
		assertEquals(2, dir.listFiles()?.count { it.isFile })
	}

	@Test
	fun `a span of real size round-trips`() = runBlocking {
		val big = "fun f() {}\n".repeat(20_000)

		store.save(one, F_ID, big)

		assertEquals(big, store.load(one, F_ID))
	}

	// A symbol id is not a filename, so the key must be hashed rather than spelled.
	@Test
	fun `a symbol id with separators in it still names one file`() = runBlocking {
		val awkward = "lexicon typescript src/deep/a b.ts Thing#method(x)."

		store.save(one, awkward, "held")

		assertEquals("held", store.load(one, awkward))
		assertNotEquals(0, dir.listFiles()?.size)
	}

	// The failure itself only reaches the log, which no gate here reads. What is pinned is that a write
	// that could not land leaves the previous draft and no half file behind.
	@Test
	fun `a save onto an unusable directory keeps the previous draft and leaves no part file`() = runBlocking {
		store.save(one, F_ID, "landed")
		assertEquals("landed", store.load(one, F_ID))

		val occupied = File(dir, "occupied").apply { writeText("a file, not a directory") }
		val blocked = storeOver(File(occupied, "drafts"))
		blocked.save(one, F_ID, "never lands")

		assertNull(blocked.load(one, F_ID))
		assertEquals("landed", store.load(one, F_ID))
		assertEquals(0, dir.listFiles()?.count { it.name.endsWith(".part") })
	}

	@Test
	fun `no leftover part file remains after a save`() = runBlocking {
		store.save(one, F_ID, "done")

		assertEquals("done", store.load(one, F_ID))
		assertEquals(0, dir.listFiles()?.count { it.name.endsWith(".part") })
	}

	// One throwing job must leave the worker alive. A dead one is not silent: everything after it runs
	// on the caller instead, which for a keystroke is the main thread.
	@Test
	fun `a job that throws leaves the worker serving, so later work is still queued`() {
		val reversing = ReversingDispatcher()
		val occupied = File(dir, "occupied").apply { writeText("a file, not a directory") }
		val under = File(occupied, "drafts")
		val store = WindowDraftStore(under, CoroutineScope(reversing))

		store.save(one, F_ID, "doomed")
		reversing.drain()
		occupied.delete()
		store.save(one, F_ID, "after")

		assertFalse(under.exists())
		reversing.drain()
		assertTrue(under.isDirectory)
	}

	// A cancelled scope leaves the queue with no worker.
	@Test
	fun `a read after the scope is cancelled still answers`() = runBlocking {
		val scope = CoroutineScope(Dispatchers.Unconfined)
		val abandoned = WindowDraftStore(dir, scope)
		abandoned.save(one, F_ID, "before the cancel")

		scope.cancel()

		withTimeout(5_000) { assertEquals("before the cancel", abandoned.load(one, F_ID)) }
	}

	@Test
	fun `a re-provision takes every draft`() = runBlocking {
		store.save(one, F_ID, "mine")
		store.save(two, G_ID, "theirs")

		store.clearAll()

		assertNull(store.load(one, F_ID))
		assertNull(store.load(two, G_ID))
	}
}
