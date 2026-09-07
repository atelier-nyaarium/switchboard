package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.runbooks.chipLabel
import com.atelier_nyaarium.switchboard.runbooks.trimmedOption
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookTextTest {
	@Test
	fun aChipSaysWhenTheOptionCarriesMoreThanItShows() {
		assertEquals("patch", chipLabel("patch"))
		assertEquals("Run the suite...", chipLabel("Run the suite\nthen report what failed"))
		assertEquals("Run the suite...", chipLabel("Run the suite\n\n\nthen report"))
	}

	@Test
	fun blankEdgesAreNotMoreToShow() {
		assertEquals("patch", chipLabel("\n\n  patch  \n\n"))
		assertEquals("patch", chipLabel("patch\n"))
	}

	@Test
	fun aLongFirstLineIsCutRatherThanLeftToTheLayout() {
		val long = "a".repeat(80)
		assertEquals("${"a".repeat(40)}...", chipLabel(long))
		assertEquals("a".repeat(40), chipLabel("a".repeat(40)))
		assertEquals("${"a".repeat(40)}...", chipLabel("a".repeat(41)))
	}

	@Test
	fun theCutNeverLeavesHalfOfASurrogatePair() {
		// Two UTF-16 units, so a 40-unit cut can land inside it.
		val rocket = String(Character.toChars(0x1F680))
		assertEquals("${"a".repeat(39)}...", chipLabel("a".repeat(39) + rocket))
		assertEquals("${"a".repeat(38)}$rocket...", chipLabel("a".repeat(38) + rocket + "b"))
	}

	@Test
	fun addingAnOptionKeepsTheIndentOfEveryLineButTheBlankEdges() {
		assertEquals("  const x = 1\n  const y = 2", trimmedOption("\n  const x = 1\n  const y = 2\n\n"))
		assertEquals("a\n\nb", trimmedOption("a\n\nb"))
	}

	@Test
	fun oneLineIsTrimmedSoTwoOptionsCannotDifferByInvisibleSpace() {
		assertEquals("patch", trimmedOption("  patch  "))
		assertEquals("", trimmedOption("   "))
		assertEquals("", trimmedOption("\n \n"))
	}
}
