package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.sha256Hex
import org.junit.Assert.assertEquals
import org.junit.Test

class RawPaintRulesTest {
	@Test
	fun `a fresh paint draws every line plain`() {
		assertEquals(RawPaint("a\nb", listOf(null, null)), plainPaint("a\nb"))
	}

	@Test
	fun `an inserted line shifts the lines below it and draws itself plain`() {
		val current = RawPaint("a\nb\nc", listOf(listOf(0L), listOf(1L), listOf(2L)))
		val adjusted = adjustPaint(current, "a\nX\nb\nc")
		assertEquals(RawPaint("a\nX\nb\nc", listOf(listOf(0L), null, listOf(1L), listOf(2L))), adjusted)
	}

	@Test
	fun `a deleted line shifts the lines below it up`() {
		val current = RawPaint("a\nb\nc", listOf(listOf(0L), listOf(1L), listOf(2L)))
		val adjusted = adjustPaint(current, "a\nc")
		assertEquals(RawPaint("a\nc", listOf(listOf(0L), listOf(2L))), adjusted)
	}

	@Test
	fun `an edit within a line draws only that line plain`() {
		val current = RawPaint("a\nbXY\nc", listOf(listOf(0L), listOf(1L), listOf(2L)))
		val adjusted = adjustPaint(current, "a\nbZ\nc")
		assertEquals(RawPaint("a\nbZ\nc", listOf(listOf(0L), null, listOf(2L))), adjusted)
	}

	@Test
	fun `unchanged text keeps its paint untouched`() {
		val current = RawPaint("a\nb", listOf(listOf(0L), listOf(1L)))
		assertEquals(current, adjustPaint(current, "a\nb"))
	}

	@Test
	fun `an answer lands only while the held text is what it was computed from`() {
		val current = RawPaint("const x = 1;", listOf(listOf(0L)))
		val landed = landPaint(current, sha256Hex(current.text), listOf(listOf(9L)))
		assertEquals(listOf(listOf(9L)), landed.lines)

		val stale = landPaint(current, sha256Hex("typed since"), listOf(listOf(9L)))
		assertEquals(current, stale)
	}

	@Test
	fun `a null-spans answer keeps the paint as it stands`() {
		val current = RawPaint("const x = 1;", listOf(listOf(7L)))
		assertEquals(current, landPaint(current, sha256Hex(current.text), null))
	}

	@Test
	fun `paint runs sit at their offset in the whole text`() {
		val paint = RawPaint("ab\ncd", listOf(listOf(0L, 2L, 0L), listOf(1L, 1L, 1L)))
		assertEquals(listOf(PaintRun(0, 2, CodeToken.KEYWORD), PaintRun(4, 5, CodeToken.TYPE)), paintRuns(paint))
	}
}
