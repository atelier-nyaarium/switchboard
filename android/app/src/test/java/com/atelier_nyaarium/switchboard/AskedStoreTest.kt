package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ADDRESS = "home.sakura.host.aaa"

private const val ROOT = "/work/repo"

private const val ID = "lexicon typescript src/a.ts f()."

class AskedStoreTest {
	private var clock = 1_000L
	private val store = AskedStore { clock }
	private val why = AskedKey(ADDRESS, ROOT, ID, "why")
	private var minted = 0L

	/** The road names each send; a counter stands in for it here. */
	private fun recordSend(scopeSubject: String, pairs: Map<AskedKey, Double?>) =
		store.record(++minted, ADDRESS, ROOT, scopeSubject, pairs)

	/** A read in the ledger's own words: only the pairs it listed, each as it now stands. */
	private fun observed(vararg listed: Pair<AskedKey, Double?>, address: String = ADDRESS, root: String = ROOT) =
		AskObservation(address, root, listed.toMap())

	@Test
	fun `a pair is out from its send until the read's createdAt moves`() {
		recordSend("SYMBOL", mapOf(why to null))

		assertTrue(store.outstanding(why))
		assertTrue(store.anyOutstanding())

		assertEquals(emptySet<String>(), store.settle(observed(why to null)))
		assertTrue(store.outstanding(why))

		assertEquals(setOf(ID), store.settle(observed(why to 9.0)))
		assertFalse(store.outstanding(why))
		assertFalse(store.anyOutstanding())
	}

	@Test
	fun `a pair settled once is not reported by a later read`() {
		recordSend("SYMBOL", mapOf(why to null))

		assertEquals(setOf(ID), store.settle(observed(why to 9.0)))
		assertEquals(emptySet<String>(), store.settle(observed(why to 9.0)))
		assertEquals(emptySet<String>(), store.settle(observed(why to 12.0)))
	}

	@Test
	fun `a pair asked while stale clears when it is reaffirmed`() {
		recordSend("SYMBOL", mapOf(why to 4.0))

		assertEquals(emptySet<String>(), store.settle(observed(why to 4.0)))
		assertTrue(store.outstanding(why))

		assertEquals(setOf(ID), store.settle(observed(why to 7.0)))
		assertFalse(store.outstanding(why))
	}

	@Test
	fun `a pair asked while stale clears when its answer is invalidated away`() {
		recordSend("SYMBOL", mapOf(why to 4.0))

		assertEquals(setOf(ID), store.settle(observed(why to null)))
		assertFalse(store.outstanding(why))
	}

	@Test
	fun `a pair the read no longer lists is left out, since a dropped pair has not moved`() {
		recordSend("SYMBOL", mapOf(why to 4.0))

		assertEquals(emptySet<String>(), store.settle(observed()))
		assertTrue(store.outstanding(why))

		assertEquals(emptySet<String>(), store.settle(observed(why.copy(question = "usage") to 9.0)))
		assertTrue(store.outstanding(why))
	}

	@Test
	fun `a pair clears 24 hours after its send and not a millisecond before`() {
		recordSend("SYMBOL", mapOf(why to null))

		clock += ASKED_TTL_MS - 1
		assertTrue(store.outstanding(why))
		assertEquals(1, store.sends.value.size)

		clock += 1
		assertFalse(store.outstanding(why))
		assertFalse(store.anyOutstanding())
		assertEquals(emptyList<AskSend>(), store.sends.value)
	}

	@Test
	fun `sending a pair again makes the newer send the one it is out on`() {
		recordSend("SYMBOL", mapOf(why to null))
		store.settle(observed(why to 5.0))
		assertFalse(store.outstanding(why))

		clock += 1_000
		val again = recordSend("SYMBOL", mapOf(why to 5.0))

		assertTrue(store.outstanding(why))
		assertEquals(again.id, store.latestFor(ADDRESS, ROOT, "SYMBOL")?.id)

		store.settle(observed(why to 6.0))
		assertFalse(store.outstanding(why))
	}

	@Test
	fun `withdrawing a failed send puts back the send it replaced`() {
		val first = recordSend("SYMBOL", mapOf(why to null))
		val second = recordSend("SYMBOL", mapOf(why to 5.0))

		// Moves the first send's pair and leaves the second's, which captured it already at 5.
		store.settle(observed(why to 5.0))
		assertTrue(store.outstanding(why))

		store.withdraw(second.id)

		assertFalse(store.outstanding(why))
		assertEquals(first.id, store.latestFor(ADDRESS, ROOT, "SYMBOL")?.id)
	}

	@Test
	fun `a read of another workspace or another session clears nothing`() {
		recordSend("SYMBOL", mapOf(why to null))

		val elsewhere = why.copy(root = "/work/other")
		val elsewhen = why.copy(address = "home.sakura.host.bbb")
		assertEquals(emptySet<String>(), store.settle(observed(elsewhere to 9.0, root = "/work/other")))
		assertEquals(emptySet<String>(), store.settle(observed(elsewhen to 9.0, address = "home.sakura.host.bbb")))

		// The observation's own root and address scope it, whatever keys it carries.
		assertEquals(emptySet<String>(), store.settle(observed(why to 9.0, root = "/work/other")))
		assertEquals(emptySet<String>(), store.settle(observed(why to 9.0, address = "home.sakura.host.bbb")))

		assertTrue(store.outstanding(why))
		assertNull(store.latestFor(ADDRESS, "/work/other", "SYMBOL"))
	}

	@Test
	fun `clearing drops every send`() {
		recordSend("SYMBOL", mapOf(why to null))
		recordSend("FILE", mapOf(why.copy(question = "usage") to null))

		store.clear()

		assertEquals(emptyList<AskSend>(), store.sends.value)
		assertFalse(store.outstanding(why))
		assertFalse(store.anyOutstanding())
		assertNull(store.latestFor(ADDRESS, ROOT, "SYMBOL"))
	}
}
