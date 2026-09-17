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

	private val load: suspend (PublishedViews.Showing<String>) -> Unit = { showing ->
		val at = reads.incrementAndGet()
		views.update(showing) { "read $at" }
	}

	@Test
	fun `work lands only on the showing it began in`() {
		val first = views.show("a") { "loading" }.showing
		assertTrue(views.update(views.show("a") { "unused" }.showing) { "joined" })
		assertEquals("joined", views.of("a"))

		val newer = views.reshow("a") { "unused" }
		assertFalse(views.update(first) { "older" })
		assertTrue(views.update(newer) { "newer" })

		views.leave("a")
		views.show("a") { "again" }
		assertFalse(views.update(newer) { "left" })
		assertEquals("again", views.of("a"))

		val beforeReprovision = views.current("a")!!
		generation.advance()
		views.clear()
		views.show("a") { "fresh" }
		assertFalse(views.update(beforeReprovision) { "previous owner" })
		assertEquals("fresh", views.of("a"))
	}

	@Test
	fun `a claim takes a view once`() {
		val showing = views.show("a") { "idle" }.showing
		assertEquals("idle", views.claim(showing, take = { it == "idle" }, taken = { "busy" }))
		assertNull(views.claim(showing, take = { it == "idle" }, taken = { "busy" }))
		assertEquals("busy", views.of("a"))
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
	private fun holding(hold: TestHold): suspend (PublishedViews.Showing<String>) -> Unit = { showing ->
		val at = reads.incrementAndGet()
		hold.pass()
		views.update(showing) { "read $at" }
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
			views.keep("a", { "loading" }) { showing ->
				reads.incrementAndGet()
				try {
					held.pass()
				} catch (e: CancellationException) {
					ended.complete(e)
					throw e
				}
				views.update(showing) { "older" }
			}
		}
		held.entered.await()

		val newer = views.reshow("a") { "unused" }

		assertNotNull(withTimeout(5_000) { ended.await() })
		assertEquals(1, reads.get())
		assertTrue(views.update(newer) { "newer" })
		assertEquals("newer", views.of("a"))

		keeping.cancelAndJoin()
	}

	@Test
	fun `the last keeper leaving ends the read`() = runBlocking {
		val held = TestHold()
		val ending = CompletableDeferred<Throwable?>()
		val keeping = launch {
			views.keep("a", { "loading" }) { showing ->
				reads.incrementAndGet()
				try {
					held.pass()
				} catch (e: CancellationException) {
					ending.complete(e)
					throw e
				}
				ending.complete(null)
				views.update(showing) { "read" }
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
			views.keep("a", { "loading" }) { showing ->
				val at = reads.incrementAndGet()
				if (at == 1) throw CancellationException("gave up")
				views.update(showing) { "read $at" }
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
}
