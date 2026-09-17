package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_800_000_000_000L

private const val DAY_MS = 86_400_000L

class FacetStateRulesTest {
	private fun symbol(name: String, module: String = "src/a.ts", kind: String = "class", startLine: Long? = 10) =
		WorkspaceFacetSymbol(symbolId = "$module#$name", name = name, symbolKind = kind, module = module, startLine = startLine)

	private fun listed(symbolId: String, facet: WorkspaceFacetAnswer) =
		WorkspaceAnswer.Read(WorkspaceListing.Listed(WorkspaceSymbolFacetAnswer(symbolId = symbolId, facet = facet)))

	private fun fileHistory(outcome: String, truncated: Boolean) =
		WorkspaceFileHistoryAnswer(
			path = "src/a.ts",
			outcome = outcome,
			commits = emptyList(),
			count = 3,
			added = 67,
			removed = 24,
			firstSeen = (NOW - 32 * DAY_MS) / 1_000,
			lastTouched = (NOW - 12 * DAY_MS) / 1_000,
			truncated = truncated,
		)

	@Test
	fun `an oversized listing names its rows in the facet's unit and its size, and without a size its rows are a floor`() {
		val sized = facetState(FacetEntry.REFERENCES, "s", WorkspaceAnswer.Read(WorkspaceListing.TooLarge(48_213, 4_213_377)))
		assertEquals("48,213 uses · 4.2 MB", (sized as FacetState.TooLarge).text)

		val floor = facetState(FacetEntry.USES, "s", WorkspaceAnswer.Read(WorkspaceListing.TooLarge(100_000, null)))
		assertEquals("100,000+ references", (floor as FacetState.TooLarge).text)
	}

	@Test
	fun `a refusal naming an update, from the plugin, Lexicon or the Gateway, draws the update notice, and any other draws its reason`() {
		val plugin = refusalOf("this session's plugin cannot read that workspace op; update it")
		val lexicon = refusalOf("this workspace op needs a newer index; update the lexicon plugin")
		val gateway = refusalOf("""[{"code":"invalid_union","path":["op"],"message":"Invalid input"}]""")
		assertTrue(listOf(plugin, lexicon, gateway).all { it.update })
		assertEquals(plugin.text, lexicon.text)

		val withheld = refusalOf("that file is withheld")
		assertFalse(withheld.update)
		assertEquals("that file is withheld", withheld.text)
	}

	@Test
	fun `an answer for another symbol or facet draws as unreachable`() {
		val members = WorkspaceFacetAnswer.Members(members = listOf(symbol("openThread")), plain = 0)
		assertTrue(facetState(FacetEntry.MEMBERS, "s", listed("s", members)) is FacetState.Shown)
		assertEquals(FacetState.Unreachable, facetState(FacetEntry.MEMBERS, "other", listed("s", members)))
		assertEquals(FacetState.Unreachable, facetState(FacetEntry.COMMENTS, "s", listed("s", members)))
		assertEquals(FacetState.Loading, facetState(FacetEntry.MEMBERS, "s", null))

		val file = WorkspaceAnswer.Read(WorkspaceListing.Listed(fileHistory("commits", truncated = false)))
		assertTrue(fileHistoryState("src/a.ts", file) is FacetState.Shown)
		assertEquals(FacetState.Unreachable, fileHistoryState("src/b.ts", file))
	}
}
