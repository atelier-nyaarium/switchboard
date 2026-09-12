package com.atelier_nyaarium.switchboard

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

private const val F_ID = "lexicon typescript src/a.ts f()."
private const val G_ID = "lexicon typescript src/a.ts g()."

class WindowDraftStoreTest {
	private lateinit var dir: File
	private lateinit var store: WindowDraftStore
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")
	private val two = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.bbb")

	@Before
	fun setUp() {
		dir = Files.createTempDirectory("window-drafts-").toFile()
		store = WindowDraftStore(dir)
	}

	@After
	fun tearDown() {
		dir.deleteRecursively()
	}

	@Test
	fun `a draft survives being reloaded`() {
		store.save(one, F_ID, "half a sentence")

		assertEquals("half a sentence", WindowDraftStore(dir).load(one, F_ID))
	}

	@Test
	fun `an absent draft reads as nothing rather than empty`() {
		assertNull(store.load(one, F_ID))
	}

	@Test
	fun `a saved empty draft is kept apart from no draft`() {
		store.save(one, F_ID, "")

		assertEquals("", store.load(one, F_ID))
	}

	@Test
	fun `two sessions of one gateway keep separate drafts`() {
		store.save(one, F_ID, "mine")
		store.save(two, F_ID, "theirs")

		assertEquals("mine", store.load(one, F_ID))
		assertEquals("theirs", store.load(two, F_ID))
	}

	@Test
	fun `two symbols of one session keep separate drafts`() {
		store.save(one, F_ID, "for f")
		store.save(one, G_ID, "for g")

		assertEquals("for f", store.load(one, F_ID))
		assertEquals("for g", store.load(one, G_ID))
	}

	@Test
	fun `a resave replaces rather than appends`() {
		store.save(one, F_ID, "first")
		store.save(one, F_ID, "second")

		assertEquals("second", store.load(one, F_ID))
	}

	@Test
	fun `clearing one draft leaves the others`() {
		store.save(one, F_ID, "for f")
		store.save(one, G_ID, "for g")

		store.clear(one, F_ID)

		assertNull(store.load(one, F_ID))
		assertEquals("for g", store.load(one, G_ID))
	}

	// One file per draft is the whole point: typing in one span must not rewrite another.
	@Test
	fun `each draft is its own file`() {
		store.save(one, F_ID, "for f")
		store.save(one, G_ID, "for g")

		assertEquals(2, dir.listFiles()?.count { it.isFile })
	}

	@Test
	fun `a span of real size round-trips`() {
		val big = "fun f() {}\n".repeat(20_000)

		store.save(one, F_ID, big)

		assertEquals(big, store.load(one, F_ID))
	}

	// A symbol id is not a filename, so the key must be hashed rather than spelled.
	@Test
	fun `a symbol id with separators in it still names one file`() {
		val awkward = "lexicon typescript src/deep/a b.ts Thing#method(x)."

		store.save(one, awkward, "held")

		assertEquals("held", store.load(one, awkward))
		assertNotEquals(0, dir.listFiles()?.size)
	}

	@Test
	fun `no leftover part file remains after a save`() {
		store.save(one, F_ID, "done")

		assertEquals(0, dir.listFiles()?.count { it.name.endsWith(".part") })
	}
}
