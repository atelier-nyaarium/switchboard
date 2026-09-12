package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val F_ID = "lexicon typescript src/a.ts f()."
private const val G_ID = "lexicon typescript src/a.ts g()."

class WindowRulesTest {
	private fun answer(text: String, hash: String, symbolId: String = F_ID): WorkspaceSymbolSourceAnswer =
		WorkspaceSymbolSourceAnswer(
			symbolId = symbolId,
			module = "src/a.ts",
			name = "f",
			text = text,
			startLine = 4,
			endLine = 9,
			spanHash = hash,
		)

	private fun window(text: String = "old", hash: String = "h1", draft: String? = null): Window =
		Window(descriptor = descriptorOf(answer(text, hash)), original = text, draft = draft)

	@Test
	fun `two sessions of one gateway never share a key`() {
		assertNotEquals(
			WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa").key,
			WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.bbb").key,
		)
	}

	@Test
	fun `a draft equal to the original is not an edit`() {
		assertFalse(window().edited)
		assertFalse(window(draft = "old").edited)
		assertTrue(window(draft = "new").edited)
	}

	@Test
	fun `the draft is what is shown once there is one`() {
		assertEquals("old", window().shown)
		assertEquals("new", window(draft = "new").shown)
	}

	@Test
	fun `an unchanged span refreshes to nothing`() {
		assertEquals(RefreshOutcome.Unchanged, refreshWith(window(), answer("old", "h1")))
	}

	@Test
	fun `a changed span adopts silently when nothing of the owner's is at stake`() {
		val fresh = answer("moved", "h2")

		assertEquals(
			RefreshOutcome.Adopted(Window(descriptor = descriptorOf(fresh), original = "moved")),
			refreshWith(window(), fresh),
		)
	}

	@Test
	fun `a changed span conflicts and keeps the owner's typing`() {
		val held = window(draft = "mine")

		assertEquals(RefreshOutcome.Conflicts(held.copy(stale = true)), refreshWith(held, answer("theirs", "h2")))
	}

	@Test
	fun `an agent request carries the original so a moved span can be refused`() {
		assertEquals(
			AgentRequest(module = "src/a.ts", symbolId = F_ID, original = "old", proposed = "new"),
			agentRequestOf(window(draft = "new")),
		)
	}

	@Test
	fun `an untouched window has nothing to ask about`() {
		assertNull(agentRequestOf(window()))
	}

	@Test
	fun `a long press accumulates, and the same symbol twice adds nothing`() {
		val f = window()
		val g = Window(descriptor = descriptorOf(answer("b", "h2", G_ID)), original = "b")

		val both = withWindow(withWindow(emptyList(), f), g)

		assertEquals(listOf(f, g), both)
		assertEquals(both, withWindow(both, f))
	}

	@Test
	fun `a window closes by its symbol and leaves the others`() {
		val held = withWindow(emptyList(), window())

		assertEquals(emptyList<Window>(), withoutWindow(held, F_ID))
		assertEquals(held, withoutWindow(held, G_ID))
	}

	@Test
	fun `only edited windows are submitted`() {
		val edited = Window(descriptor = descriptorOf(answer("b", "h2", G_ID)), original = "b", draft = "c")

		assertEquals(listOf(edited), editedWindows(listOf(window(), edited)))
	}
}
