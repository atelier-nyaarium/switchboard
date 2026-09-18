package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeEntry
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FacetDetailRulesTest {
	@Test
	fun `the detail reads header, reached use, knowledge, documentation, source, then facts last, and the jump finds the reached line`() {
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
			knowledge = WorkspaceAnswer.Read(WorkspaceKnowledgeAnswer(symbolId = "s", documentation = "what it does")),
		)
		val reached = Reached("LocalBackendSession", "Type", 99)
		val items = detailItems(view, reached, whole = false)

		assertEquals(listOf("h", "r", "k", "d", "st"), items.take(5).map { it.key })
		assertEquals("f", items.last().key)
		assertEquals(99, reachedIndex(items)!!.let { items[it] as DetailItem.SourceLine }.line.number!!.toInt())
		assertTrue(items.none { it is DetailItem.ShowAll })

		val plain = detailItems(view.copy(knowledge = null), null, whole = false)
		assertEquals(listOf("h", "k", "st"), plain.take(3).map { it.key })
		assertEquals("f", plain.last().key)
		assertNull(reachedIndex(plain))
	}

	@Test
	fun `a recorded describe draws under the header, and an unrecorded one stays out`() {
		val recorded = DetailView(
			knowledge = WorkspaceAnswer.Read(
				WorkspaceKnowledgeAnswer(
					symbolId = "s",
					answers = listOf(WorkspaceKnowledgeEntry("describe", "It opens threads.")),
				),
			),
		)
		assertEquals(DetailItem.Describe("It opens threads."), detailItems(recorded, null, whole = false)[1])

		val unrecorded = DetailView(knowledge = WorkspaceAnswer.Read(WorkspaceKnowledgeAnswer(symbolId = "s")))
		assertTrue(detailItems(unrecorded, null, whole = false).none { it is DetailItem.Describe })
	}
}
