package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PublishedViewsTest {
	private val generation = WorkspaceGeneration()
	private val views = PublishedViews<String, String>(generation)

	@Test
	fun `work lands only on the showing it began in`() {
		val first = views.show("a") { "loading" }
		assertTrue(views.update(views.show("a") { "unused" }) { "joined" })
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
		val showing = views.show("a") { "idle" }
		assertEquals("idle", views.claim(showing, take = { it == "idle" }, taken = { "busy" }))
		assertNull(views.claim(showing, take = { it == "idle" }, taken = { "busy" }))
		assertEquals("busy", views.of("a"))
	}
}
