package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FacetDetailRulesTest {
	@Test
	fun `the detail reads header, reached use, facts, knowledge, documentation, then source, and the jump finds the reached line`() {
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

		assertEquals(
			listOf("h", "r", "f", "k", "d", "st"),
			items.take(6).map { it.key },
		)
		assertEquals(99, reachedIndex(items)!!.let { items[it] as DetailItem.SourceLine }.line.number!!.toInt())
		assertTrue(items.none { it is DetailItem.ShowAll })

		val plain = detailItems(view.copy(knowledge = null), null, whole = false)
		assertEquals(listOf("h", "f", "k", "st"), plain.take(4).map { it.key })
		assertNull(reachedIndex(plain))
	}
}
