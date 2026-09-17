package com.atelier_nyaarium.switchboard

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PublishedViewsTest {
	private val generation = WorkspaceGeneration()
	private val views = PublishedViews<String, String>(generation)

	private val reads = AtomicInteger()

	private val load: suspend (PublishedViews.ReadTicket<String>) -> Unit = { ticket ->
		val at = reads.incrementAndGet()
		views.update(ticket) { "read $at" }
	}

	@Test
	fun `work lands only on the showing it began in`() {
		val opened = views.show("a") { "loading" }.showing
		assertTrue(views.update(views.ticket(opened)) { "joined" })
		assertEquals("joined", views.of("a"))

		// Minted last, so only the showing can refuse it.
		val stale = views.ticket(opened)
		val newer = views.reshow("a") { "unused" }
		assertFalse(views.update(stale) { "older" })
		assertTrue(views.update(views.ticket(newer)) { "newer" })

		views.leave("a")
		views.show("a") { "again" }
		assertFalse(views.update(views.ticket(newer)) { "left" })
		assertEquals("again", views.of("a"))

		val beforeReprovision = views.begin("a")!!
		generation.advance()
		views.clear()
		views.show("a") { "fresh" }
		assertFalse(views.update(beforeReprovision) { "previous owner" })
		assertEquals("fresh", views.of("a"))
	}

	@Test
	fun `a read that began earlier lands nothing once a later one has, and nothing begins on a key not shown`() {
		val showing = views.show("a") { "loading" }.showing
		val older = views.ticket(showing)
		val newer = views.ticket(showing)

		assertTrue(views.update(newer) { "newer" })
		assertFalse(views.update(older) { "older" })
		assertEquals("newer", views.of("a"))

		// The ticket that landed may land again, which is one op redrawing its own view.
		assertTrue(views.update(newer) { "again" })
		assertEquals("again", views.of("a"))

		assertNull(views.begin("b"))
	}

	@Test
	fun `two slots of one key land independently`() {
		val showing = views.show("a") { "" }.showing
		val source = views.ticket(showing, "source")
		val known = views.ticket(showing, "knowledge")

		assertTrue(views.update(known) { "$it knowledge" })
		assertTrue(views.update(source) { "$it source" })
		assertEquals(" knowledge source", views.of("a"))
	}

	@Test
	fun `a claim takes a view once, and an older ticket cannot take it after a newer read landed`() {
		val showing = views.show("a") { "idle" }.showing
		val ticket = views.ticket(showing)
		assertEquals("idle", views.claim(ticket, take = { it == "idle" }, taken = { "busy" }))
		assertNull(views.claim(ticket, take = { it == "idle" }, taken = { "busy" }))
		assertEquals("busy", views.of("a"))

		val older = views.ticket(showing)
		assertTrue(views.update(views.ticket(showing)) { "idle" })
		assertNull(views.claim(older, take = { it == "idle" }, taken = { "taken" }))
		assertEquals("idle", views.of("a"))
	}

	@Test
	fun `a change that awaited nothing lands on whatever stands, and nothing once the key left`() {
		val showing = views.show("a") { "idle" }.showing
		views.update(views.ticket(showing)) { "read" }

		assertTrue(views.now("a") { "tapped" })
		assertEquals("tapped", views.of("a"))

		views.leave("a")
		assertFalse(views.now("a") { "gone" })
		assertNull(views.of("a"))
	}

	@Test
	fun `only the call that started a showing is told so, again after it is left and after a re-provision`() {
		assertTrue(views.show("a") { "loading" }.started)
		assertFalse(views.show("a") { "unused" }.started)

		views.leave("a")
		assertTrue(views.show("a") { "loading" }.started)

		generation.advance()
		views.clear()
		assertTrue(views.show("a") { "loading" }.started)
	}

	@Test
	fun `the keys with keepers are what a sweep reads, and a key merely shown is not one`() = runBlocking {
		assertTrue(views.kept().isEmpty())
		val keeping = launch { views.keep("a", { "loading" }, load) }
		withTimeout(5_000) { views.all.first { it["a"] == "read 1" } }
		views.show("b") { "shown" }

		assertEquals(setOf("a"), views.kept())

		keeping.cancelAndJoin()
		assertTrue(views.kept().isEmpty())
	}

	/**
	 * A keeper looks for a drawn view before it asks to show one, so a second keeper arriving in that
	 * window finds nothing drawn either. Only one of them may read.
	 */
	@Test
	fun `a keeper arriving while another is starting the same key joins without reading`() = runBlocking {
		val starting = CountDownLatch(1)
		val checked = CountDownLatch(1)
		val keeping = launch(Dispatchers.Default) {
			views.keep(
				key = "a",
				initial = {
					starting.countDown()
					checked.await()
					"loading"
				},
				load = load,
			)
		}
		assertTrue(starting.await(5, TimeUnit.SECONDS))
		assertNull(views.of("a"))

		checked.countDown()
		val joiner = views.show("a") { "loading" }

		assertFalse(joiner.started)
		withTimeout(5_000) { views.all.first { it["a"] == "read 1" } }
		assertEquals(1, reads.get())

		keeping.cancelAndJoin()
	}

	/** Held at the read, so a keeper can be cancelled while the answer is still out. */
	private fun holding(hold: TestHold): suspend (PublishedViews.ReadTicket<String>) -> Unit = { ticket ->
		val at = reads.incrementAndGet()
		hold.pass()
		views.update(ticket) { "read $at" }
	}

	@Test
	fun `a keeper leaving while another remains does not take the read with it`() = runBlocking {
		val held = TestHold()
		val first = launch { views.keep("a", { "loading" }, holding(held)) }
		held.entered.await()
		val second = launch { views.keep("a", { "loading" }, holding(held)) }
		yield()

		first.cancelAndJoin()
		held.release()

		withTimeout(5_000) { views.all.first { it["a"] == "read 1" } }
		assertEquals(1, reads.get())

		second.cancelAndJoin()
		assertNull(views.of("a"))
	}

	@Test
	fun `a reshow ends the read of the showing it replaces`() = runBlocking {
		val held = TestHold()
		val ended = CompletableDeferred<Throwable?>()
		val keeping = launch {
			views.keep("a", { "loading" }) { ticket ->
				reads.incrementAndGet()
				try {
					held.pass()
				} catch (e: CancellationException) {
					ended.complete(e)
					throw e
				}
				views.update(ticket) { "older" }
			}
		}
		held.entered.await()

		val newer = views.reshow("a") { "unused" }

		assertNotNull(withTimeout(5_000) { ended.await() })
		assertEquals(1, reads.get())
		assertTrue(views.update(views.ticket(newer)) { "newer" })
		assertEquals("newer", views.of("a"))

		keeping.cancelAndJoin()
	}

	@Test
	fun `the last keeper leaving ends the read`() = runBlocking {
		val held = TestHold()
		val ending = CompletableDeferred<Throwable?>()
		val keeping = launch {
			views.keep("a", { "loading" }) { ticket ->
				reads.incrementAndGet()
				try {
					held.pass()
				} catch (e: CancellationException) {
					ending.complete(e)
					throw e
				}
				ending.complete(null)
				views.update(ticket) { "read" }
			}
		}
		held.entered.await()

		keeping.cancelAndJoin()

		assertNotNull(withTimeout(5_000) { ending.await() })
		assertNull(views.of("a"))
	}

	// A read can give up on its own, the way one under a timeout does.
	@Test
	fun `a read that ends without finishing leaves the showing for another read`() = runBlocking {
		val keeping = launch {
			views.keep("a", { "loading" }) { ticket ->
				val at = reads.incrementAndGet()
				if (at == 1) throw CancellationException("gave up")
				views.update(ticket) { "read $at" }
			}
		}

		withTimeout(5_000) { views.all.first { it["a"] == "read 2" } }
		assertEquals(2, reads.get())

		keeping.cancelAndJoin()
	}

	@Test
	fun `two keepers of one key read it once, and it stays drawn until both leave`() = runBlocking {
		val first = launch { views.keep("a", { "loading" }, load) }
		withTimeout(5_000) { views.all.first { it["a"] == "read 1" } }
		val second = launch { views.keep("a", { "loading" }, load) }
		yield()

		first.cancelAndJoin()
		yield()

		assertEquals(1, reads.get())
		assertEquals("read 1", views.of("a"))

		second.cancelAndJoin()
		assertNull(views.of("a"))
	}

	@Test
	fun `a keeper's read landing after a later read of its key draws nothing`() = runBlocking {
		val held = TestHold()
		val landed = CompletableDeferred<Unit>()
		val keeping = launch {
			views.keep("a", { "loading" }) { ticket ->
				val at = reads.incrementAndGet()
				held.pass()
				views.update(ticket) { "read $at" }
				landed.complete(Unit)
			}
		}
		held.entered.await()

		// A sweep of the same key, begun after the keeper's read and landing before it.
		val sweep = views.begin("a")!!
		assertTrue(views.update(sweep) { "swept" })

		held.release()
		withTimeout(5_000) { landed.await() }

		assertEquals("swept", views.of("a"))

		keeping.cancelAndJoin()
	}
}
