package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeQuestion
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeSymbol
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

	private fun answer(
		createdAt: Double?,
		root: String = ROOT,
		question: String = "why",
		symbolId: String = ID,
	): WorkspaceKnowledgeScopeAnswer =
		WorkspaceKnowledgeScopeAnswer(
			root = root,
			module = "src/a.ts",
			symbols = listOf(
				WorkspaceScopeSymbol(
					symbolId = symbolId,
					name = "f",
					symbolKind = "function",
					depth = 0,
					questions = listOf(WorkspaceScopeQuestion(question = question, createdAt = createdAt, askCount = 0)),
				),
			),
			localsExcluded = 0,
		)

	@Test
	fun `a pair is out from its send until its answer's createdAt moves`() {
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to null))

		assertTrue(store.outstanding(why))
		assertTrue(store.anyOutstanding())

		assertEquals(emptySet<String>(), store.settle(ADDRESS, answer(null)))
		assertTrue(store.outstanding(why))

		assertEquals(setOf(ID), store.settle(ADDRESS, answer(9.0)))
		assertFalse(store.outstanding(why))
		assertFalse(store.anyOutstanding())
	}

	@Test
	fun `a pair asked while stale clears when it is reaffirmed`() {
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to 4.0))

		assertEquals(emptySet<String>(), store.settle(ADDRESS, answer(4.0)))
		assertTrue(store.outstanding(why))

		assertEquals(setOf(ID), store.settle(ADDRESS, answer(7.0)))
		assertFalse(store.outstanding(why))
	}

	@Test
	fun `a pair asked while stale clears when its answer is invalidated away`() {
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to 4.0))

		assertEquals(setOf(ID), store.settle(ADDRESS, answer(null)))
		assertFalse(store.outstanding(why))
	}

	@Test
	fun `a pair clears 24 hours after its send and not a millisecond before`() {
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to null))

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
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to null))
		store.settle(ADDRESS, answer(5.0))
		assertFalse(store.outstanding(why))

		clock += 1_000
		val again = store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to 5.0))

		assertTrue(store.outstanding(why))
		assertEquals(again.id, store.latestFor(ADDRESS, ROOT, "SYMBOL")?.id)

		store.settle(ADDRESS, answer(6.0))
		assertFalse(store.outstanding(why))
	}

	@Test
	fun `withdrawing a failed send puts back the send it replaced`() {
		val first = store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to null))
		val second = store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to 5.0))

		// Moves the first send's pair and leaves the second's, which captured it already at 5.
		store.settle(ADDRESS, answer(5.0))
		assertTrue(store.outstanding(why))

		store.withdraw(second)

		assertFalse(store.outstanding(why))
		assertEquals(first.id, store.latestFor(ADDRESS, ROOT, "SYMBOL")?.id)
	}

	@Test
	fun `an answer from another root clears nothing`() {
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to null))

		assertEquals(emptySet<String>(), store.settle(ADDRESS, answer(9.0, root = "/work/other")))
		assertEquals(emptySet<String>(), store.settle("home.sakura.host.bbb", answer(9.0)))

		assertTrue(store.outstanding(why))
		assertNull(store.latestFor(ADDRESS, "/work/other", "SYMBOL"))
	}

	@Test
	fun `clearing drops every send`() {
		store.record(ADDRESS, ROOT, "SYMBOL", mapOf(why to null))
		store.record(ADDRESS, ROOT, "FILE", mapOf(why.copy(question = "usage") to null))

		store.clear()

		assertEquals(emptyList<AskSend>(), store.sends.value)
		assertFalse(store.outstanding(why))
		assertFalse(store.anyOutstanding())
		assertNull(store.latestFor(ADDRESS, ROOT, "SYMBOL"))
	}
}
