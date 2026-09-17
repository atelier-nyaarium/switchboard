package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodePaintTest {
	private fun use(
		text: String?,
		startColumn: Long,
		endColumn: Long,
		spans: List<Long>? = null,
		textStart: Long? = null,
	) = WorkspaceFacetUse(
		module = "src/a.ts",
		line = 7,
		startColumn = startColumn,
		endColumn = endColumn,
		name = "target",
		role = "call",
		text = text,
		textStart = textStart,
		spans = spans,
	)

	private fun painted(line: PaintedLine, run: PaintRun): String = line.text.substring(run.start, run.end)

	@Test
	fun `a line's runs take their tokens and leave gaps plain`() {
		val lines = paintSource("let x = 1;", listOf(listOf(0L, 3L, 0L, 8L, 1L, 8L)), 4)
		val line = lines.single()
		assertEquals(4L, line.number)
		assertEquals("let x = 1;", line.text)
		assertEquals(listOf("let" to CodeToken.KEYWORD, "1" to CodeToken.NUMBER), line.runs.map { painted(line, it) to it.token })
	}

	@Test
	fun `a run past the line's end is clipped, unordered and overlapping triples are ordered and trimmed, an unknown token and a partial triple paint nothing`() {
		val triples = listOf(
			8L, 40L, 4L,
			0L, 6L, 0L,
			3L, 5L, 2L,
			0L, 2L, 9_999L,
			40L, 1L, 0L,
			1L, 1L,
		)
		val line = paintSource("abcdefghij", listOf(triples), 1).single()
		assertEquals(
			listOf(Triple(0, 6, CodeToken.KEYWORD), Triple(6, 8, CodeToken.FUNCTION), Triple(8, 10, CodeToken.STRING)),
			line.runs.map { Triple(it.start, it.end, it.token) },
		)
	}

	@Test
	fun `a carriage return is not text`() {
		val lines = paintSource("one\r\ntwo\r\n", null, 1)
		assertEquals(listOf("one", "two", ""), lines.map { it.text })
	}

	@Test
	fun `a use row trims its indentation and underlines the name as written`() {
		val line = useLinePaint(use("\t\tconst v = target(a);", 12, 18, listOf(2L, 5L, 0L, 12L, 6L, 2L)))
		assertEquals("const v = target(a);", line.text)
		assertEquals("target", line.text.substring(line.hit!!.first, line.hit.last + 1))
		assertEquals(listOf("const" to CodeToken.KEYWORD, "target" to CodeToken.FUNCTION), line.runs.map { painted(line, it) to it.token })
	}

	@Test
	fun `a name past the row's width opens the row just before it`() {
		val lead = "x".repeat(200)
		val line = useLinePaint(use("$lead target;", 201, 207))
		assertEquals("target", line.text.substring(line.hit!!.first, line.hit.last + 1))
		assertTrue(line.text.startsWith("..."))
		assertEquals(USE_ROW_LEAD + 3, line.hit.first)
	}

	@Test
	fun `a row as wide as the mock's cuts to the name a phone would otherwise never draw`() {
		val text = "openThread(options: { cwd: string; model?: string; serviceTier?: CodexServiceTier }): Promise<string>;"
		val at = text.indexOf("Promise").toLong()
		val line = useLinePaint(use(text, at, at + 7))
		assertTrue(line.text.startsWith("..."))
		assertEquals("Promise", line.text.substring(line.hit!!.first, line.hit.last + 1))
		assertTrue(line.hit.last + 1 <= USE_ROW_COLUMNS)
	}

	@Test
	fun `added and removed never read alike, in either theme`() {
		for (dark in listOf(true, false)) assertNotEquals(diffTint(dark).added, diffTint(dark).removed)
	}

	@Test
	fun `a window the plugin cut says so, since the row is all the reader sees`() {
		val line = useLinePaint(use("target(a);", 1_000, 1_006, textStart = 1_000))
		assertEquals("...target(a);", line.text)
		assertEquals("target", line.text.substring(line.hit!!.first, line.hit.last + 1))
	}

	@Test
	fun `the source opens at the declaration, or around the reached line once it lies past the preview`() {
		val lines = paintSource((1..200).joinToString("\n") { "line $it" }, null, 1)

		val head = sourceWindow(lines, null, whole = false)
		assertEquals(1L to 40L, head.lines.first().number to head.lines.last().number)
		assertEquals(0 to 160, head.hiddenAbove to head.hiddenBelow)
		assertTrue(head.lines.none { it.marked })

		val near = sourceWindow(lines, 30, whole = false)
		assertEquals(1L, near.lines.first().number)
		assertEquals(30L, near.lines.single { it.marked }.number)

		val far = sourceWindow(lines, 100, whole = false)
		assertEquals(94L to 133L, far.lines.first().number to far.lines.last().number)
		assertEquals(93 to 67, far.hiddenAbove to far.hiddenBelow)
		assertEquals(100L, far.lines.single { it.marked }.number)
	}

	@Test
	fun `a reached line outside the source marks nothing`() {
		val lines = paintSource((1..10).joinToString("\n") { "line $it" }, null, 1)
		val window = sourceWindow(lines, 99, whole = false)
		assertTrue(window.lines.none { it.marked })
		assertEquals(10, window.lines.size)
	}

	@Test
	fun `a whole source shows every line`() {
		val lines = paintSource((1..200).joinToString("\n") { "line $it" }, null, 1)
		val window = sourceWindow(lines, 100, whole = true)
		assertEquals(200, window.lines.size)
		assertEquals(0 to 0, window.hiddenAbove to window.hiddenBelow)
		assertEquals(100L, window.lines.single { it.marked }.number)
	}

	@Test
	fun `a line past the column limit is cut with its runs`() {
		val text = "y".repeat(MAX_PAINT_COLUMNS + 50)
		val line = paintSource(text, listOf(listOf(0L, 600L, 4L)), 1).single()
		assertEquals(MAX_PAINT_COLUMNS, line.text.length)
		assertEquals(MAX_PAINT_COLUMNS, line.runs.single().end)
	}

	@Test
	fun `a member's signature drops its own name`() {
		val member = WorkspaceFacetSymbol(
			symbolId = "s",
			name = "startTurn",
			symbolKind = "method",
			module = "src/a.ts",
			signature = "startTurn(options: Spec): Promise<string>\nunused",
			signatureSpans = listOf(listOf(0L, 9L, 2L, 19L, 4L, 1L)),
		)
		val line = signaturePaint(member)!!
		assertEquals("(options: Spec): Promise<string>", line.text)
		assertEquals(listOf("Spec" to CodeToken.TYPE), line.runs.map { painted(line, it) to it.token })
		assertNull(line.number)

		assertNull(signaturePaint(member.copy(signature = null)))
	}

	@Test
	fun `every token has a style, and the mocks' colours are the palette's`() {
		for (token in CodeToken.entries) assertNotNull(token.wire, CodePalette.styleOf(token))
		assertEquals(0xFFFF7B72, CodePalette.styleOf(CodeToken.KEYWORD).argb)
		assertEquals(0xFFFFA657, CodePalette.styleOf(CodeToken.TYPE).argb)
		assertEquals(0xFFFFA657, CodePalette.styleOf(CodeToken.BUILTIN).argb)
		assertEquals(0xFFD2A8FF, CodePalette.styleOf(CodeToken.FUNCTION).argb)
		assertEquals(0xFFA5D6FF, CodePalette.styleOf(CodeToken.STRING).argb)
		assertEquals(0xFF79C0FF, CodePalette.styleOf(CodeToken.NUMBER).argb)
		assertEquals(0xFF8B949E, CodePalette.styleOf(CodeToken.COMMENT).argb)
		assertTrue(CodePalette.styleOf(CodeToken.SECTION).bold)
		assertTrue(CodePalette.styleOf(CodeToken.EMPHASIS).italic)
		assertEquals(0xFF033A16, CodePalette.styleOf(CodeToken.ADDITION).background)
	}
}
