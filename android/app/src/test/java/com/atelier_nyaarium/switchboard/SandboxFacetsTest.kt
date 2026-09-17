package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_800_000_000_000L

private const val LEGACY_ID = "lexicon typescript src/shared/schemasRoutine.ts routineRefusal()."

class SandboxFacetsTest {
	private val modules = sandboxModules()
	private val facets = SandboxFacets(modules) { NOW }

	private val sessionId = sandboxSymbolId("typescript", SESSION_MODULE, "LocalBackendSession")
	private val hubId = sandboxSymbolId("typescript", HUB_MODULE, "hubEvent")

	private fun listed(symbolId: String, facet: WorkspaceFacet): WorkspaceFacetAnswer? =
		((facets.facet(symbolId, facet) as? WorkspaceAnswer.Read)?.value as? WorkspaceListing.Listed)?.value?.facet

	private fun usesOf(symbolId: String) = listed(symbolId, WorkspaceFacet.Uses) as? WorkspaceFacetAnswer.Uses

	private fun targetsOf(symbolId: String) = listed(symbolId, WorkspaceFacet.UsesFrom) as? WorkspaceFacetAnswer.UsesFrom

	private fun historyOf(path: String): WorkspaceFileHistoryAnswer? =
		((facets.fileHistory(path) as? WorkspaceAnswer.Read)?.value as? WorkspaceListing.Listed)?.value

	private fun everyUse(): List<WorkspaceFacetUse> =
		modules.values.flatMap { module ->
			module.symbols.flatMap { symbol ->
				(usesOf(symbol.symbolId)?.rows ?: emptyList()) +
					(targetsOf(symbol.symbolId)?.targets?.flatMap { it.uses } ?: emptyList())
			}
		}

	/** Every facet is checked on its own, or one drill-in that lists nothing hides the rest. */
	@Test
	fun `every sandbox count is what its drill-in lists`() {
		for (module in modules.values) {
			for (symbol in module.symbols) {
				val at = "${module.path}#${symbol.name}"
				val counts = facets.counts(symbol.symbolId)!!
				val members = listed(symbol.symbolId, WorkspaceFacet.Members) as WorkspaceFacetAnswer.Members
				val hierarchy = listed(symbol.symbolId, WorkspaceFacet.Hierarchy) as WorkspaceFacetAnswer.Hierarchy
				val comments = listed(symbol.symbolId, WorkspaceFacet.Comments) as WorkspaceFacetAnswer.Comments

				assertEquals(at, members.members.size.toLong(), counts.members)
				assertEquals(
					at,
					(hierarchy.supertypes.size + hierarchy.ancestors.size + hierarchy.unbound.size).toLong(),
					hierarchy.supertypeCount,
				)
				assertEquals(at, hierarchy.subtypes.size.toLong(), hierarchy.subtypeCount)
				assertEquals(at, hierarchy.supertypeCount, counts.supertypes)
				assertEquals(at, hierarchy.subtypeCount, counts.subtypes)
				assertEquals(at, comments.comments.size.toLong(), comments.total)
				assertEquals(at, comments.total, counts.comments)

				// Null only where the listing is too large, which lists no row to count.
				val uses = usesOf(symbol.symbolId)
				if (uses != null) {
					assertEquals(at, uses.rows.size.toLong(), uses.uses)
					assertEquals(at, uses.rows.size.toLong(), counts.uses)
					assertEquals(at, uses.rows.map { it.module }.distinct().size.toLong(), counts.useFiles)
					assertEquals(at, uses.rows.mapNotNull { it.topLevel?.symbolId }.distinct().size.toLong(), counts.dependents)
					assertEquals(
						at,
						uses.rows.filter { it.topLevel == null }.map { it.module }.distinct().size.toLong(),
						counts.dependentFiles,
					)
				}

				val targets = targetsOf(symbol.symbolId)
				if (targets != null) {
					assertEquals(at, targets.targets.size.toLong(), targets.targetCount)
					assertEquals(at, targets.targets.sumOf { it.uses.size }.toLong(), targets.references)
					assertEquals(at, targets.targets.size.toLong(), counts.targets)
					assertEquals(at, targets.targets.count { it.target != null }.toLong(), counts.boundTargets)
					assertEquals(at, targets.targets.sumOf { it.uses.size }.toLong(), counts.references)
				}
			}
		}
	}

	@Test
	fun `a symbol's own leading comment is documentation, in no row and no count`() {
		val tier = sandboxSymbolId("typescript", IDENTITY_MODULE, "CodexServiceTier")
		val comments = listed(tier, WorkspaceFacet.Comments) as WorkspaceFacetAnswer.Comments

		assertNotNull(facets.documentation(tier))
		assertEquals(0, comments.comments.size)
		assertEquals(0L, facets.counts(tier)!!.comments)
	}

	@Test
	fun `an indirect supertype is listed and counted`() {
		val vault = sandboxSymbolId("kotlin", VAULT_SEALING_MODULE, "VaultSealing")
		val hierarchy = listed(vault, WorkspaceFacet.Hierarchy) as WorkspaceFacetAnswer.Hierarchy

		assertEquals(1, hierarchy.supertypes.size)
		assertEquals(1, hierarchy.ancestors.size)
		assertEquals(2L, hierarchy.supertypeCount)
	}

	@Test
	fun `the local session answers the numbers its screens were drawn for`() {
		val counts = facets.counts(sessionId)!!

		assertEquals(13L, counts.uses)
		assertEquals(7L, counts.useFiles)
		assertEquals(8L, counts.dependents)
		assertEquals(3L, counts.targets)
		assertEquals(2L, counts.boundTargets)
		assertEquals(7L, counts.references)
		assertEquals(7L, counts.members)
		assertEquals(0L, counts.supertypes)
		assertEquals(3L, counts.subtypes)
		assertEquals(5L, counts.comments)
	}

	@Test
	fun `a withheld use appears in no row and no count`() {
		val rows = usesOf(sessionId)!!.rows

		assertTrue(rows.none { sandboxWithheld(it.module) })
		assertEquals(rows.size.toLong(), facets.counts(sessionId)!!.uses)
	}

	@Test
	fun `the hub lists its uses across every user file, some at file level`() {
		val rows = usesOf(hubId)!!.rows

		assertEquals(1200, rows.size)
		assertEquals(90, rows.map { it.module }.distinct().size)
		assertEquals(9, rows.count { it.topLevel == null })
		assertEquals(270, rows.mapNotNull { it.topLevel?.symbolId }.distinct().size)
	}

	@Test
	fun `a use row's columns frame the name it points at`() {
		for (use in everyUse()) {
			val text = use.text.orEmpty()
			val from = use.startColumn.toInt()
			val to = use.endColumn.toInt()
			assertTrue("${use.module}:${use.line}", to <= text.length)
			assertEquals("${use.module}:${use.line}", use.name, text.substring(from, to))
		}
	}

	@Test
	fun `history answers commits for a tracked file and untracked for another`() {
		val tracked = historyOf(SESSION_MODULE)!!

		assertEquals(3L, tracked.count)
		assertEquals(67L, tracked.added)
		assertEquals(24L, tracked.removed)
		assertEquals(3, tracked.commits.size)
		assertTrue(tracked.commits.all { it.at < NOW / 1_000 })

		val untracked = historyOf(UNTRACKED_MODULE)!!
		assertEquals(0, untracked.commits.size)

		val symbolHistory = listed(
			sandboxSymbolId("typescript", UNTRACKED_MODULE, "probe"),
			WorkspaceFacet.History,
		) as WorkspaceFacetAnswer.History
		assertEquals(untracked.outcome, symbolHistory.outcome)
		assertEquals(0, symbolHistory.commits.size)
	}

	@Test
	fun `a symbol from the older plugin refuses every drill-in with an update`() {
		for (facet in listOf(
			WorkspaceFacet.Uses,
			WorkspaceFacet.UsesFrom,
			WorkspaceFacet.Members,
			WorkspaceFacet.Hierarchy,
			WorkspaceFacet.Comments,
			WorkspaceFacet.History,
		)) {
			val refused = facets.facet(LEGACY_ID, facet) as WorkspaceAnswer.Refused
			assertTrue(refusalOf(refused.reason).update)
		}
		val history = facets.fileHistory("src/shared/schemasRoutine.ts") as WorkspaceAnswer.Refused

		assertTrue(refusalOf(history.reason).update)
		assertNull(facets.counts(LEGACY_ID))
	}

	@Test
	fun `sandbox spans stay inside their line and in order`() {
		for (module in modules.values) {
			for (line in module.lines) {
				val spans = sandboxSpans(module.language, line)
				assertEquals(0, spans.size % 3)
				var edge = 0L
				for (at in spans.indices step 3) {
					val start = spans[at]
					val end = start + spans[at + 1]
					assertTrue(module.path, start >= edge)
					assertTrue(module.path, spans[at + 1] > 0)
					assertTrue(module.path, end <= line.length.toLong())
					assertTrue(module.path, CodeToken.of(spans[at + 2]) != null)
					edge = end
				}
			}
		}
	}
}
