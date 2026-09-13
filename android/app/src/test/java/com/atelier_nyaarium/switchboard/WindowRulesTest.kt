package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val F_ID = "lexicon typescript src/a.ts f()."
private const val G_ID = "lexicon typescript src/a.ts g()."

/** The range is DERIVED from the text, or a fixture claims six lines while holding one. */
private fun answer(
	text: String,
	hash: String,
	symbolId: String = F_ID,
	startLine: Long = 4,
): WorkspaceSymbolSourceAnswer =
	WorkspaceSymbolSourceAnswer(
		symbolId = symbolId,
		module = "src/a.ts",
		name = "f",
		text = text,
		startLine = startLine,
		endLine = startLine + text.split("\n").size - 1,
		spanHash = hash,
	)

private fun window(
	text: String = "old",
	hash: String = "h1",
	draft: String? = null,
	symbolId: String = F_ID,
	startLine: Long = 4,
): Window = Window(descriptor = descriptorOf(answer(text, hash, symbolId, startLine)), original = text, draft = draft)

private fun outlineSymbol(name: String, kind: String) =
	WorkspaceOutlineSymbol(symbolId = "lexicon typescript src/a.ts $name.", name = name, symbolKind = kind)

class WindowRulesTest {
	// A symbol id can hold the separator, so the join escapes it rather than refusing. A part spelling
	// the escape must not then key as one holding the separator itself.
	@Test
	fun `a key part holding the separator joins, and cannot be spelled by another part`() {
		separated("a${KEY_SEPARATOR}b", "c")

		assertFalse(separated("%1e", "c") == separated(KEY_SEPARATOR, "c"))
	}

	// Typing the original back is not an edit, and nothing else would notice if it were.
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

	// What an applied ask looks like: the owner asked, the agent wrote it, and the file now says it.
	@Test
	fun `a span that caught up with the draft adopts rather than conflicting`() {
		val held = window(draft = "mine")
		val fresh = answer("mine", "h2")

		assertEquals(
			RefreshOutcome.Adopted(held.copy(descriptor = descriptorOf(fresh), original = "mine", draft = null)),
			refreshWith(held, fresh),
		)
	}

	@Test
	fun `a changed span conflicts and keeps the owner's typing`() {
		val held = window(draft = "mine")

		assertEquals(RefreshOutcome.Conflicts(held.copy(stale = true)), refreshWith(held, answer("theirs", "h2")))
	}

	private fun saveAnswer(outcome: String, current: WorkspaceSymbolSourceAnswer?, gone: Boolean? = null) =
		WorkspaceSaveSpanAnswer(symbolId = F_ID, outcome = outcome, current = current, gone = gone)

	@Test
	fun `a save lands the span it wrote, keeping typing that arrived after the send`() {
		val written = answer("sent", "h2")

		assertEquals(
			window(draft = "sent").copy(descriptor = descriptorOf(written), original = "sent", draft = null),
			afterSave(window(draft = "sent"), "sent", saveAnswer(SAVE_SAVED, written)),
		)
		assertEquals("sent, and more", afterSave(window(draft = "sent, and more"), "sent", saveAnswer(SAVE_SAVED, written))?.draft)
	}

	@Test
	fun `only a span that no longer resolves leaves no window, and one not read back or refused stays`() {
		assertNull(afterSave(window(draft = "x"), "x", saveAnswer(SAVE_SAVED, null, gone = true)))
		assertEquals(
			window(draft = "x, and more").copy(stale = true),
			afterSave(window(draft = "x, and more"), "x", saveAnswer(SAVE_SAVED, null, gone = true)),
		)
		assertEquals(window(draft = "x"), afterSave(window(draft = "x"), "x", saveAnswer(SAVE_SAVED, null)))
		assertEquals(window(draft = "x"), afterSave(window(draft = "x"), "x", saveAnswer(SAVE_REJECTED, null)))
	}

	@Test
	fun `a stale save raises the banner unless the span already holds the owner's text`() {
		val held = window(draft = "mine")

		assertEquals(held.copy(stale = true), afterSave(held, "mine", saveAnswer(SAVE_STALE, answer("theirs", "h2"))))
		assertEquals(held.copy(stale = true), afterSave(held, "mine", saveAnswer(SAVE_STALE, null)))
		assertFalse(afterSave(held, "mine", saveAnswer(SAVE_STALE, answer("mine", "h2")))!!.edited)
	}

	@Test
	fun `a save notice names what happened and nothing when nothing did`() {
		assertNull(saveNotice(SaveReport()))
		assertEquals("Saved", saveNotice(SaveReport(saved = 1)))
		assertEquals(
			"Saved 2. 1 in an open refactor. 1 stale. 1 not confirmed. no such symbol",
			saveNotice(SaveReport(saved = 2, joined = 1, stale = 1, unknown = 1, refused = listOf("no such symbol", "no such symbol"))),
		)
	}

	@Test
	fun `an agent request carries the original so a moved span can be refused`() {
		assertEquals(
			AgentRequest(module = "src/a.ts", symbolId = F_ID, original = "old", proposed = "new"),
			agentRequestOf(window(draft = "new")),
		)
	}

	@Test
	fun `a long press accumulates, and the same symbol twice adds nothing`() {
		val f = window()
		val g = window(text = "b", hash = "h2", symbolId = G_ID)

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
		val edited = window(text = "b", hash = "h2", symbolId = G_ID, draft = "c")

		assertEquals(listOf(edited), editedWindows(listOf(window(), edited)))
		assertNull(agentRequestOf(window()))
	}

	// Line numbers arrive one-based, so a span starting at 4 draws its first line as 4.
	@Test
	fun `a span on its own is numbered and unbanded`() {
		assertEquals(listOf(CodeLine(4, "one"), CodeLine(5, "two")), spanLines(answer("one\ntwo", "h1")))
	}

	@Test
	fun `without the file a window is its span and no context`() {
		assertEquals(WindowParts(emptyList(), "old", emptyList()), windowParts(window(), null))
	}

	@Test
	fun `the file supplies the lines either side, and the span is its own text`() {
		val file = (1..12).map { "line $it" }
		val held = window(text = "four\nfive\nsix\nseven\neight\nnine")

		assertEquals(
			WindowParts(
				above = listOf(CodeLine(2, "line 2"), CodeLine(3, "line 3")),
				span = "four\nfive\nsix\nseven\neight\nnine",
				below = listOf(CodeLine(10, "line 10"), CodeLine(11, "line 11")),
			),
			windowParts(held, file),
		)
	}

	// A span at either end of a file must not ask it for a line it does not have.
	@Test
	fun `context stops at the file's edges`() {
		val file = listOf("first", "middle", "last")

		assertEquals(
			WindowParts(emptyList(), "first", listOf(CodeLine(2, "middle"), CodeLine(3, "last"))),
			windowParts(window(text = "first", startLine = 1), file),
		)
		assertEquals(
			WindowParts(listOf(CodeLine(1, "first"), CodeLine(2, "middle")), "last", emptyList()),
			windowParts(window(text = "last", startLine = 3), file),
		)
	}

	// Two cards would otherwise draw the same lines, with a gap count that denies it.
	@Test
	fun `context stops at the neighbouring window`() {
		val file = (1..12).map { "line $it" }

		assertEquals(
			WindowParts(listOf(CodeLine(3, "line 3")), "old", listOf(CodeLine(5, "line 5"))),
			windowParts(window(), file, previousEnd = 2, nextStart = 6),
		)
	}

	// The numbers below are the file's, so a draft that grew does not renumber what it did not change.
	@Test
	fun `a draft that grew leaves the context below where the file has it`() {
		val file = (1..8).map { "line $it" }

		assertEquals(
			WindowParts(
				above = listOf(CodeLine(2, "line 2"), CodeLine(3, "line 3")),
				span = "mine\nand more\nand more still",
				below = listOf(CodeLine(5, "line 5"), CodeLine(6, "line 6")),
			),
			windowParts(window(draft = "mine\nand more\nand more still"), file),
		)
	}

	// The count is what neither card draws, or it announces a skip over lines both are showing.
	@Test
	fun `a gap counts only the lines no card draws`() {
		val first = window()
		val far = window(text = "x", hash = "h2", symbolId = G_ID, startLine = 20)
		val touching = window(text = "x", hash = "h3", symbolId = G_ID, startLine = 5)
		val coveredByContext = window(text = "x", hash = "h4", symbolId = G_ID, startLine = 6)

		assertEquals(11, gapBetween(first, far))
		assertNull(gapBetween(first, touching))
		assertNull(gapBetween(first, coveredByContext))
	}

	@Test
	fun `windows are drawn in file order, not tap order`() {
		val early = window()
		val late = window(text = "x", hash = "h2", symbolId = G_ID, startLine = 90)

		assertEquals(listOf(early, late), inFileOrder(listOf(late, early)))
	}

	// A whole word only, or a one-letter name marks the letter inside every other identifier.
	@Test
	fun `the amber mark covers the name and nothing that merely contains it`() {
		assertEquals(13 until 14, markOf("export const f = 1;", "f"))
		assertNull(markOf("const offset = 1;", "f"))
		assertNull(markOf("nothing here", "f"))
	}

	@Test
	fun `the mark lands on the first line holding the name, not every line`() {
		val lines = spanLines(answer("/** about f */\nexport function f() {}\n\tf();", "h1"))

		assertEquals(listOf(10 until 11, null, null), lines.map { it.mark })
	}

	@Test
	fun `a nested declaration is indented under its container`() {
		val parent = outlineSymbol("Shop", "class")
		val child = outlineSymbol("add", "method").copy(containerId = parent.symbolId)
		val grandchild = outlineSymbol("qty", "parameter").copy(containerId = child.symbolId)
		val symbols = listOf(parent, child, grandchild)

		assertEquals(
			mapOf(parent.symbolId to 0, child.symbolId to 1, grandchild.symbolId to 2),
			outlineDepths(symbols),
		)
	}

	// A container the answer does not carry is not a reason to indent, nor to walk forever.
	@Test
	fun `an unknown or circular container indents nothing`() {
		val orphan = outlineSymbol("a", "const").copy(containerId = "lexicon typescript src/a.ts gone.")
		val loop = outlineSymbol("b", "const").copy(containerId = "lexicon typescript src/a.ts b.")

		assertEquals(mapOf(orphan.symbolId to 0), outlineDepths(listOf(orphan)))
		assertEquals(mapOf(loop.symbolId to 0), outlineDepths(listOf(loop)))
	}

	@Test
	fun `a directory counts children and a file shows its size`() {
		assertEquals("4", treeMeta(WorkspaceTreeEntry(name = "src", directory = true, children = 4)))
		assertEquals("9 KB", treeMeta(WorkspaceTreeEntry(name = "a.ts", directory = false, bytes = 9_431)))
		assertNull(treeMeta(WorkspaceTreeEntry(name = "a.ts", directory = false)))
		assertTrue(opensDirectory(WorkspaceTreeEntry(name = "src", directory = true)))
		assertFalse(opensDirectory(WorkspaceTreeEntry(name = "a.ts", directory = false)))
	}

	@Test
	fun `a file is read once however many windows it holds`() {
		val a = window()
		val b = window(text = "x", hash = "h2", symbolId = G_ID, startLine = 20)

		assertEquals(listOf("src/a.ts"), modulesOf(listOf(a, b)))
	}

	// A neighbour in another file bounds nothing, or one file's window would clip another's context.
	@Test
	fun `only a neighbour in the same file bounds a window`() {
		val first = window()
		val second = window(text = "x", hash = "h2", symbolId = G_ID, startLine = 20)
		val elsewhere = second.let { it.copy(descriptor = it.descriptor.copy(module = "src/b.ts")) }

		assertEquals(null to 20, neighbourBounds(listOf(first, second), 0))
		assertEquals(4 to null, neighbourBounds(listOf(first, second), 1))
		assertEquals(null to null, neighbourBounds(listOf(first, elsewhere), 1))
		assertFalse(opensModule(listOf(first, second), 1))
		assertTrue(opensModule(listOf(first, second), 0))
		assertTrue(opensModule(listOf(first, elsewhere), 1))
	}

	@Test
	fun `nothing edited is no message at all`() {
		assertNull(applyMessage(emptyList()))
	}

	// The id and the original are what let the agent refuse rather than write over a span that moved.
	@Test
	fun `a message carries the id, the module, what was shown and what is wanted`() {
		val message = applyMessage(listOf(agentRequestOf(window(draft = "fun f() { mine() }"))!!))!!

		assertTrue(message.contains(F_ID))
		assertTrue(message.contains("src/a.ts"))
		assertTrue(message.contains("old"))
		assertTrue(message.contains("fun f() { mine() }"))
	}

	@Test
	fun `several spans are counted and all carried`() {
		val f = agentRequestOf(window(draft = "for f"))!!
		val g = agentRequestOf(window(text = "b", hash = "h2", symbolId = G_ID, draft = "for g"))!!

		val message = applyMessage(listOf(f, g))!!

		assertTrue(message.contains("2 spans"))
		assertTrue(message.contains("for f"))
		assertTrue(message.contains("for g"))
	}

	// A span can hold a fenced block in a comment, and a three-backtick fence would end there.
	@Test
	fun `a fence outruns the longest backtick run inside`() {
		assertEquals("```", fenceFor("nothing to escape"))
		assertEquals("```", fenceFor("a `tick` and ``two``"))
		assertEquals("````", fenceFor("/** ```ts */"))
		assertEquals("``````", fenceFor("`````"))
	}

	@Test
	fun `a span holding a fence is wrapped in a longer one`() {
		val held = window(text = "/** ```ts\n * example\n * ``` */", hash = "h1", draft = "/** changed ``` */")

		val message = applyMessage(listOf(agentRequestOf(held)!!))!!

		assertTrue(message.contains("````\n/** ```ts"))
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
