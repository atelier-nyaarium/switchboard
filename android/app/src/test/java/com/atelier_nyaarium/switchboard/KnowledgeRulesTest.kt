package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeNote
import org.junit.Assert.assertEquals
import org.junit.Test

class KnowledgeRulesTest {
	private val sound = WorkspaceKnowledgeNote(
		text = "Returns the reason.",
		revision = 1,
		sourceChanged = false,
		changedRefs = 0,
		brokenRefs = 0,
	)

	@Test
	fun `a note badges what moved since it was saved, and a sound one badges nothing`() {
		assertEquals(emptyList<NoteBadge>(), noteBadges(sound))

		val moved = sound.copy(sourceChanged = true, changedRefs = 1, brokenRefs = 1_200)
		assertEquals(
			listOf(
				NoteBadge("SOURCE CHANGED", warning = true),
				NoteBadge("1 REF CHANGED", warning = true),
				NoteBadge("1,200 REFS BROKEN", warning = true),
			),
			noteBadges(moved),
		)
	}
}
