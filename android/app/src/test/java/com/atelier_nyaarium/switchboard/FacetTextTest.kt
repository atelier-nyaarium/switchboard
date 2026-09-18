package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

private const val NOW = 1_800_000_000_000L

private const val DAY_MS = 86_400_000L

class FacetTextTest {
	@Test
	fun `ages read minutes, hours, days, weeks, months and years at each boundary`() {
		fun ago(ms: Long) = agoText(NOW - ms, NOW)
		assertEquals("just now", ago(59_000))
		assertEquals("1 min ago", ago(60_000))
		assertEquals("59 min ago", ago(59 * 60_000))
		assertEquals("1 hour ago", ago(3_600_000))
		assertEquals("23 hours ago", ago(23 * 3_600_000))
		assertEquals("1 day ago", ago(DAY_MS))
		assertEquals("13 days ago", ago(13 * DAY_MS))
		assertEquals("2 weeks ago", ago(14 * DAY_MS))
		assertEquals("7 weeks ago", ago(55 * DAY_MS))
		assertEquals("1 month ago", ago(56 * DAY_MS))
		assertEquals("12 months ago", ago(364 * DAY_MS))
		assertEquals("1 year ago", ago(365 * DAY_MS))
		assertEquals("just now", ago(-DAY_MS))
		assertEquals("12 days", spanText(12 * DAY_MS))
	}

	@Test
	fun `a count groups its digits wherever it is read`() {
		assertEquals("13", countText(13))
		assertEquals("1,200", countText(1_200))
		assertEquals("48,213 uses · 4.2 MB", tooLargeText("uses", 48_213, 4_213_377))
	}

	@Test
	fun `a symbol on one line names that line, not a range of itself`() {
		assertEquals("a.ts : 13", whereText("a.ts", 13, 13))
		assertEquals("a.ts : 13", whereText("a.ts", 13, null))
		assertEquals("a.ts : 26-43", whereText("a.ts", 26, 43))
		assertEquals("a.ts", whereText("a.ts", null, null))
	}

	@Test
	fun `prose reads a backtick span as code, and an unmatched backtick stays literal`() {
		assertEquals(
			listOf(ProseSegment.Plain("See "), ProseSegment.Code("answerBlobOp"), ProseSegment.Plain(" for details")),
			proseSegments("See `answerBlobOp` for details"),
		)
		assertEquals(
			listOf(ProseSegment.Code("a"), ProseSegment.Plain(" and "), ProseSegment.Code("b")),
			proseSegments("`a` and `b`"),
		)
		assertEquals(listOf(ProseSegment.Plain("it's `weird")), proseSegments("it's `weird"))
		assertEquals(
			listOf(ProseSegment.Plain("a "), ProseSegment.Code(""), ProseSegment.Plain(" b")),
			proseSegments("a `` b"),
		)
	}
}
