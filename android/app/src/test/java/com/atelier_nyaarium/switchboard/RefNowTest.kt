package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.plugins.references.RefNow
import com.atelier_nyaarium.switchboard.plugins.references.refNow
import com.atelier_nyaarium.switchboard.plugins.references.sentLines
import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta
import com.atelier_nyaarium.switchboard.proto.RefSegmentMeta
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RefNowTest {
	private val sentFile = listOf("import x;", "", "function f() {", "  const a = 1;", "  return a;", "}").joinToString("\n")

	/** Lines 4-5, inside `f` which began at line 3, hashed as the sender hashes them. */
	private val key = RefKeyMeta(
		key = "ref://a.ts:f#const",
		startLine = 4,
		endLine = 5,
		quality = "exact",
		spanHash = hashContent("  const a = 1;\n  return a;"),
		symbolId = "lexicon typescript a.ts f().",
		symbolStartLine = 3,
	)

	private val sent = listOf("  const a = 1;", "  return a;")

	@Test
	fun `the key's lines found at the same offset in a moved declaration match`() {
		val moved = "// added\n// added\n$sentFile"

		assertEquals(RefNow.Matches, refNow(key, sent, declared = 5L..8L, file = moved))
	}

	@Test
	fun `a changed line differs at the lines it sits on now, and so do lines the declaration no longer reaches`() {
		val edited = sentFile.replace("return a;", "return a + 1;")

		assertEquals(
			RefNow.Differs(startLine = 4, lines = listOf("  const a = 1;", "  return a + 1;"), changed = setOf(5L)),
			refNow(key, sent, declared = 3L..6L, file = edited),
		)
		assertTrue(refNow(key, sent, declared = 3L..4L, file = sentFile) is RefNow.Differs)
	}

	@Test
	fun `a declaration shortened to nothing differs, not unknown`() {
		assertTrue(refNow(key, sent, declared = 1L..1L, file = "") is RefNow.Differs)
	}

	@Test
	fun `nothing is claimed for an inexact key, or without the send-time start, the declaration now, or the file`() {
		assertEquals(RefNow.Unknown, refNow(key.copy(quality = "fuzzy"), sent, 3L..6L, sentFile))
		assertEquals(RefNow.Unknown, refNow(key.copy(symbolStartLine = null), sent, 3L..6L, sentFile))
		assertEquals(RefNow.Unknown, refNow(key, sent, declared = null, file = sentFile))
		assertEquals(RefNow.Unknown, refNow(key, sent, declared = 3L..6L, file = null))
	}

	@Test
	fun `the sent lines come from a snippet's segments, and a snippet missing them gives none`() {
		val meta = RefFileMeta(
			refPath = "a.ts",
			segments = listOf(RefSegmentMeta(startLine = 3, lineCount = 3)),
			keys = listOf(key),
		)
		val snippet = listOf("function f() {", "  const a = 1;", "  return a;").joinToString("\n")

		assertEquals(sent, sentLines(meta, key, snippet))
		assertNull(sentLines(meta, key.copy(endLine = 6), snippet))
		assertEquals(sent, sentLines(RefFileMeta(refPath = "a.ts", keys = listOf(key)), key, sentFile))
	}
}
