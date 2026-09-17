package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetComment
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUnboundType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FacetStructureRulesTest {
	private fun symbol(name: String, module: String = "src/a.ts", kind: String = "class", startLine: Long? = 10) =
		WorkspaceFacetSymbol(symbolId = "$module#$name", name = name, symbolKind = kind, module = module, startLine = startLine)

	@Test
	fun `members name their kind when they share one, and kind chips appear only for two kinds or more`() {
		val methods = (1..7).map { symbol("m$it", kind = "method") }
		assertEquals("7 methods, in source order", membersSubtitle(methods))
		assertEquals(emptyList<OutlineKind>(), memberChips(methods))

		val mixed = methods + symbol("held", kind = "property")
		assertEquals("8 members, in source order", membersSubtitle(mixed))
		assertEquals(listOf("All", "Method", "Property"), memberChips(mixed).map { it.label })
		assertEquals("property", kindNoun("property", 1))
		assertEquals("properties", kindNoun("property", 2))
	}

	@Test
	fun `a member chip leaves only its kind, and All leaves every member in source order`() {
		val members = listOf(symbol("m1", kind = "method"), symbol("held", kind = "property"), symbol("m2", kind = "method"))

		assertEquals(members, membersOfKind(members, null))
		assertEquals(listOf("m1", "m2"), membersOfKind(members, "method").map { it.name })
		assertEquals(emptyList<WorkspaceFacetSymbol>(), membersOfKind(members, "class"))
		// Every chip the screen offers selects the rows it counted.
		for (chip in memberChips(members).filter { it.kind != null }) {
			assertEquals(chip.count, membersOfKind(members, chip.kind).size)
		}
	}

	@Test
	fun `the hierarchy reads farthest ancestor first down to the symbol, with an unresolved base dashed and closed`() {
		val column = hierarchyColumn(
			WorkspaceFacetAnswer.Hierarchy(
				subject = symbol("LocalBackendSession", kind = "interface"),
				supertypes = listOf(WorkspaceFacetType(symbol("Base"), "extends")),
				ancestors = listOf(symbol("Nearer"), symbol("Farthest")),
				unbound = listOf(WorkspaceFacetUnboundType("Error", "extends")),
				subtypes = listOf(WorkspaceFacetType(symbol("CodexLocalSession"), "implements")),
				supertypeCount = 4,
				subtypeCount = 1,
			),
		)
		assertEquals(listOf("Farthest", "Nearer", "Base", "Error"), column.above.map { node ->
			when (node) {
				is TypeNode.Known -> node.name
				is TypeNode.Unbound -> node.name
			}
		})
		assertEquals("extends", (column.above.last() as TypeNode.Unbound).tag)
		assertEquals("interface", column.self.tag)
		assertTrue(column.self.self)
		assertFalse(column.self.opens)
		assertEquals(listOf("implements"), column.below.map { (it as TypeNode.Known).tag })
		assertTrue(column.below.all { (it as TypeNode.Known).opens })
		assertEquals(column.above.size + 1 + column.below.size, (column.above + column.self + column.below).map { it.key }.distinct().size)
	}

	@Test
	fun `comments list in line order under their holder, split their code, and a capped page says so`() {
		val answer = WorkspaceFacetAnswer.Comments(
			comments = listOf(
				WorkspaceFacetComment("second `turn`, then `model`", "leading", 29, symbol("startTurn", kind = "method")),
				WorkspaceFacetComment("first", "trailing", 27, null),
			),
			total = 5,
		)
		val items = commentItems(answer)
		assertEquals(listOf(27L, 29L), items.map { it.line })
		assertEquals(listOf("TRAILING", "LEADING"), items.map { it.form })
		assertNull(items.first().opens)
		assertEquals(Reached("Comment", "LEADING", 29), items.last().opens!!.reached)
		assertEquals(
			listOf("second " to false, "turn" to true, ", then " to false, "model" to true),
			items.last().parts.map { it.text to it.code },
		)
		assertEquals(listOf("a `b" to false), textParts("a `b").map { it.text to it.code })
		assertEquals("5 inside it", commentsSubtitle(answer))
		assertEquals("first 2 inside it", commentsSubtitle(answer.copy(truncated = true)))
	}
}
