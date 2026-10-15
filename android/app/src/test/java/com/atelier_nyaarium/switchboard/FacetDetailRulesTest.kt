package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeNote
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FacetDetailRulesTest {
	@Test
	fun `the detail reads header, reached use, note, documentation, source, then facts last, and the jump finds the reached line`() {
		val view = DetailView(
			source = WorkspaceAnswer.Read(
				WorkspaceSymbolSourceAnswer(
					symbolId = "s",
					module = "src/a.ts",
					name = "start",
					text = (93..130).joinToString("\n") { "line $it" },
					startLine = 93,
					endLine = 130,
					spanHash = "h",
				),
			),
			knowledge = WorkspaceAnswer.Read(knowledgeOf("s", note = note, documentation = "what it does")),
		)
		val reached = Reached("LocalBackendSession", "Type", 99)
		val items = detailItems(view, reached, whole = false)

		assertEquals(listOf("h", "r", "n", "d", "st"), items.take(5).map { it.key })
		assertEquals("f", items.last().key)
		assertEquals(99, reachedIndex(items)!!.let { items[it] as DetailItem.SourceLine }.line.number!!.toInt())
		assertTrue(items.none { it is DetailItem.ShowAll })

		val plain = detailItems(view.copy(knowledge = null), null, whole = false)
		assertEquals(listOf("h", "st"), plain.take(2).map { it.key })
		assertEquals("f", plain.last().key)
		assertNull(reachedIndex(plain))
	}

	@Test
	fun `a symbol with no note draws no note`() {
		val unnoted = DetailView(knowledge = WorkspaceAnswer.Read(knowledgeOf("s")))
		assertTrue(detailItems(unnoted, null, whole = false).none { it is DetailItem.Note })
	}

	private val note = WorkspaceKnowledgeNote(
		text = "It opens threads.",
		revision = 1,
		sourceChanged = false,
		proposal = false,
		changedRefs = 0,
		brokenRefs = 0,
	)
}
