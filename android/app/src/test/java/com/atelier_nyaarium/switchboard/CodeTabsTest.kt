package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.workspace.annotatedOf
import com.atelier_nyaarium.switchboard.workspace.tabOffsetMapping
import org.junit.Assert.assertEquals
import org.junit.Test

class CodeTabsTest {
	@Test
	fun `a leading tab reaches the first stop`() {
		assertEquals("    x", expandTabs("\tx").text)
	}

	@Test
	fun `a tab after 1, 2, 3 or 4 characters reaches the next stop`() {
		assertEquals("a   b", expandTabs("a\tb").text)
		assertEquals("ab  c", expandTabs("ab\tc").text)
		assertEquals("abc d", expandTabs("abc\td").text)
		assertEquals("abcd    e", expandTabs("abcd\te").text)
	}

	@Test
	fun `several lines each reset the column at their own start`() {
		assertEquals("a   b\nc   d", expandTabs("a\tb\nc\td").text)
	}

	@Test
	fun `a line without tabs is unchanged`() {
		val expanded = expandTabs("plain text")
		assertEquals("plain text", expanded.text)
		for (i in 0..expanded.text.length) assertEquals(i, expanded.toExpandedOffsets[i])
	}

	@Test
	fun `both maps round-trip for every original offset`() {
		val text = "a\tbc\td\n\te"
		val expanded = expandTabs(text)
		for (i in 0..text.length) {
			assertEquals(i, expanded.toOriginalOffsets[expanded.toExpandedOffsets[i]])
		}
	}

	@Test
	fun `a painted line's runs land on the same characters after expansion`() {
		val line = PaintedLine(text = "\tfoo", runs = listOf(PaintRun(1, 4, CodeToken.KEYWORD)))
		val annotated = annotatedOf(line)
		assertEquals("    foo", annotated.text)
		val range = annotated.spanStyles.single()
		assertEquals("foo", annotated.text.substring(range.start, range.end))
	}

	@Test
	fun `the offset mapping never answers an offset inside a tab's run`() {
		val expanded = expandTabs("a\tb")
		val mapping = tabOffsetMapping(expanded)
		for (i in 0..3) assertEquals(expanded.toExpandedOffsets[i], mapping.originalToTransformed(i))
		val runStart = mapping.originalToTransformed(1)
		val runEnd = mapping.originalToTransformed(2)
		for (e in runStart until runEnd) assertEquals(1, mapping.transformedToOriginal(e))
		assertEquals(2, mapping.transformedToOriginal(runEnd))
	}

	// A range built against different text can name an offset this text does not have.
	@Test
	fun `an offset past either map's end clamps rather than throwing`() {
		val expanded = expandTabs("a\tb")
		assertEquals(expanded.toExpandedOffsets.last(), expanded.expandedOffset(999))
		assertEquals(expanded.toOriginalOffsets.last(), expanded.originalOffset(999))
		assertEquals(expanded.toExpandedOffsets.first(), expanded.expandedOffset(-5))
		assertEquals(expanded.toOriginalOffsets.first(), expanded.originalOffset(-5))
	}
}
