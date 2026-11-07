package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerFieldTest {
	private val length = 100f
	private val tail = length * 0.18f
	private val parts = 12

	private fun List<CometSpan>.covered(): Float = sumOf { (it.end - it.start).toDouble() }.toFloat()

	@Test
	fun everySpanLiesOnThePathAndTheTailKeepsItsLength() {
		listOf(0f, 0.02f, 0.25f, 0.99f, 1f).forEach { progress ->
			val spans = cometSpans(progress = progress, length = length)

			spans.forEach { span ->
				assertTrue(span.start >= 0f)
				assertTrue(span.start < span.end)
				assertTrue(span.end <= length)
			}
			assertEquals(tail, spans.covered(), 0.0001f)
		}
	}

	@Test
	fun theHeadIsBrightAndTheTailFadesBehindIt() {
		val spans = cometSpans(progress = 0.25f, length = length)

		assertEquals(1f, spans.first().alpha, 0f)
		assertTrue(spans.last().alpha > 0f)
		assertTrue(spans.zipWithNext().all { (nearer, farther) -> nearer.alpha > farther.alpha })
	}

	@Test
	fun theHeadLeadsAndNothingWrapsOnceTheTailFitsBehindIt() {
		listOf(0.25f, 0.99f, 1f).forEach { progress ->
			val spans = cometSpans(progress = progress, length = length)

			assertEquals(parts, spans.size)
			assertEquals(progress * length, spans.first().end, 0f)
			assertTrue(spans.none { it.start == 0f })
		}
	}

	@Test
	fun aTailCrossingThePathStartWrapsOnePartInTwoPieces() {
		val spans = cometSpans(progress = 0.01f, length = length)
		val wrapped = spans.take(2)

		assertEquals(parts + 1, spans.size)
		assertEquals(wrapped[0].alpha, wrapped[1].alpha, 0f)
		assertEquals(0f, wrapped[0].start, 0f)
		assertEquals(length, wrapped[1].end, 0f)
		assertEquals(tail / parts, wrapped.covered(), 0.0001f)
	}

	@Test
	fun aBusySessionRunsOneCometTeammatesTwoAndAWorkflowThree() {
		assertEquals(Comet.WORKFLOW, cometFor(SessionWord.LIVE, workflow = true, teammates = true))
		assertEquals(null, cometFor(SessionWord.ENDED, workflow = true, teammates = true))
		assertEquals(null, cometFor(SessionWord.AVAILABLE, workflow = true, teammates = true))
		assertEquals(null, cometFor(null, workflow = false))
		assertEquals(Comet.TURN, cometFor(SessionWord.WORKING, workflow = false))
		assertEquals(Comet.TEAMMATES, cometFor(SessionWord.WORKING, workflow = false, teammates = true))
		assertEquals(Comet.TEAMMATES, cometFor(SessionWord.LIVE, workflow = false, teammates = true))
		assertEquals(null, cometFor(SessionWord.AVAILABLE, workflow = false, teammates = true))
		assertEquals(Comet.WORKFLOW, cometFor(SessionWord.WORKING, workflow = true, teammates = true))
		val state = ChatState(
			teams = listOf(
				testTeam("a", working = true, workflow = true),
				testTeam("b", working = true, teammates = true),
			),
		)
		assertEquals(Comet.WORKFLOW, cometOf(state, "a", 0L))
		assertEquals(Comet.TEAMMATES, cometOf(state, "b", 0L))
		assertEquals(null, cometOf(state, "missing", 0L))
	}

	@Test
	fun cometsSpreadEvenlyAndTheGlowSitsBehindEachHead() {
		val heads = cometHeads(0.9f, 3)
		assertEquals(listOf(0.9f, 0.2333f, 0.5667f), heads.map { Math.round(it * 10_000f) / 10_000f })

		val glow = glowSpans(0.5f, length, Comet.TURN)
		assertEquals(50f, glow.single().end, 0.0001f)
		assertEquals(length * Comet.TURN.tail * 3f / Comet.TURN.parts, glow.covered(), 0.0001f)
	}
}
