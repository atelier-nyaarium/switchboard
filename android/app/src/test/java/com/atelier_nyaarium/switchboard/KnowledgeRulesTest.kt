package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KnowledgeRulesTest {
	private val id = "lexicon typescript src/shared/schemasRoutine.ts routineRefusal()."

	@Test
	fun `every question draws a row, recorded ones with their badges, and an older plugin draws none`() {
		val answer = WorkspaceKnowledgeAnswer(
			symbolId = id,
			answers = listOf(
				WorkspaceKnowledgeEntry(question = "describe", prose = "Returns the reason.", thin = true),
				WorkspaceKnowledgeEntry(question = "why", prose = "A rule can name nothing.", stale = true, doubted = true),
				WorkspaceKnowledgeEntry(question = "usage"),
			),
		)

		assertEquals(
			listOf(
				KnowledgeRow("describe", "Returns the reason.", listOf(KnowledgeBadge.THIN)),
				KnowledgeRow("why", "A rule can name nothing.", listOf(KnowledgeBadge.STALE, KnowledgeBadge.DOUBTED)),
				KnowledgeRow("usage", null, emptyList()),
			),
			knowledgeRows(answer),
		)
		assertNull(knowledgeRows(WorkspaceKnowledgeAnswer(symbolId = id)))
	}
}
