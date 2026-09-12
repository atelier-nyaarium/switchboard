package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
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

	// Line numbers arrive one-based, so a span starting at 4 draws its first line as 4.
	@Test
	fun `a span on its own is numbered and unbanded`() {
		assertEquals(listOf(CodeLine(4, "one"), CodeLine(5, "two")), spanLines(answer("one\ntwo", "h1")))
	}

	@Test
	fun `without the file a window is its span alone, banded`() {
		assertEquals(listOf(CodeLine(4, "old", true)), windowLines(window(), null))
	}

	@Test
	fun `the file supplies the lines either side, unbanded`() {
		val file = (1..12).map { "line $it" }
		val held = window(text = "four\nfive\nsix\nseven\neight\nnine")

		assertEquals(
			listOf(
				CodeLine(2, "line 2"),
				CodeLine(3, "line 3"),
				CodeLine(4, "four", true),
				CodeLine(5, "five", true),
				CodeLine(6, "six", true),
				CodeLine(7, "seven", true),
				CodeLine(8, "eight", true),
				CodeLine(9, "nine", true),
				CodeLine(10, "line 10"),
				CodeLine(11, "line 11"),
			),
			windowLines(held, file),
		)
	}

	// A span at the very top or bottom must not ask the file for a line it does not have.
	@Test
	fun `context stops at the file's edges`() {
		val lines = windowLines(window(text = "old"), listOf("old"))

		assertEquals(listOf(CodeLine(4, "old", true)), lines)
	}

	// Two cards would otherwise draw the same lines, with a gap count that denies it.
	@Test
	fun `context stops at the neighbouring window`() {
		val file = (1..12).map { "line $it" }
		val oneLine = window().let { it.copy(descriptor = it.descriptor.copy(endLine = 4)) }

		assertEquals(
			listOf(CodeLine(3, "line 3"), CodeLine(4, "old", true), CodeLine(5, "line 5")),
			windowLines(oneLine, file, previousEnd = 2, nextStart = 6),
		)
	}

	@Test
	fun `a gap is the lines the viewer skipped, and touching windows have none`() {
		val first = window()
		val next = Window(
			descriptor = descriptorOf(answer("x", "h2", G_ID)).copy(startLine = 20, endLine = 24),
			original = "x",
		)
		val touching = Window(
			descriptor = descriptorOf(answer("x", "h3", G_ID)).copy(startLine = 10, endLine = 12),
			original = "x",
		)

		assertEquals(10, gapBetween(first, next))
		assertNull(gapBetween(first, touching))
	}

	@Test
	fun `windows are drawn in file order, not tap order`() {
		val early = window()
		val late = Window(
			descriptor = descriptorOf(answer("x", "h2", G_ID)).copy(startLine = 90, endLine = 95),
			original = "x",
		)

		assertEquals(listOf(early, late), inFileOrder(listOf(late, early)))
	}

	@Test
	fun `the chips count every kind, commonest first, behind an All`() {
		val symbols = listOf(
			outlineSymbol("a", "const"),
			outlineSymbol("b", "function"),
			outlineSymbol("c", "const"),
			outlineSymbol("d", "type"),
		)

		assertEquals(
			listOf(
				OutlineKind(null, "All", 4),
				OutlineKind("const", "Const", 2),
				OutlineKind("function", "Function", 1),
				OutlineKind("type", "Type", 1),
			),
			outlineKinds(symbols),
		)
		assertEquals(listOf("a", "c"), outlineOfKind(symbols, "const").map { it.name })
		assertEquals(4, outlineOfKind(symbols, null).size)
	}
}

private fun outlineSymbol(name: String, kind: String) =
	WorkspaceOutlineSymbol(symbolId = "lexicon typescript src/a.ts $name.", name = name, symbolKind = kind)
