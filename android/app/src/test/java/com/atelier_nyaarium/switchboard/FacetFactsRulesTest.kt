package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeCounts
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeFacts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_800_000_000_000L

private const val DAY_MS = 86_400_000L

class FacetFactsRulesTest {
	private fun counts(
		uses: Long = 0,
		useFiles: Long = 0,
		dependents: Long = 0,
		dependentFiles: Long = 0,
		targets: Long = 0,
		boundTargets: Long = 0,
		references: Long = 0,
		members: Long = 0,
		supertypes: Long = 0,
		subtypes: Long = 0,
		comments: Long = 0,
	) = WorkspaceKnowledgeCounts(
		uses = uses,
		useFiles = useFiles,
		dependents = dependents,
		dependentFiles = dependentFiles,
		targets = targets,
		boundTargets = boundTargets,
		references = references,
		members = members,
		supertypes = supertypes,
		subtypes = subtypes,
		comments = comments,
	)

	private fun knowledge(kind: String?, counted: WorkspaceKnowledgeCounts?) =
		WorkspaceKnowledgeAnswer(
			symbolId = "src/a.ts#Sub",
			symbolKind = kind,
			facts = WorkspaceKnowledgeFacts(
				members = 7,
				references = 13,
				fanIn = 8,
				fanOut = 2,
				supertypes = 1,
				subtypes = 3,
				comments = 5,
				counts = counted,
			),
		)

	private fun commit(hash: String, atMillis: Long) =
		WorkspaceHistoryCommit(hash = hash, at = atMillis / 1_000, subject = "did a thing", added = 4, removed = 1)

	private fun history(outcome: String, commits: List<WorkspaceHistoryCommit>) =
		WorkspaceFacetAnswer.History(
			outcome = outcome,
			module = "src/mcp/local/localAgentSession.ts",
			startLine = 26,
			endLine = 43,
			commits = commits,
			truncated = false,
		)

	private fun valueOf(rows: List<FactRow>, entry: FacetEntry): String = rows.single { it.entry == entry }.value

	private fun opensOf(rows: List<FactRow>, entry: FacetEntry): Boolean = rows.single { it.entry == entry }.opens

	@Test
	fun `fact rows carry their units and read none at zero, and a zero row does not open`() {
		val full = factRows(
			knowledge(
				"interface",
				counts(
					uses = 13, useFiles = 7, dependents = 8, dependentFiles = 1, targets = 3, boundTargets = 2,
					members = 7, subtypes = 3, comments = 5,
				),
			),
			null,
			NOW,
		) as FactRows.Counted
		assertEquals(
			listOf(
				FacetEntry.MEMBERS, FacetEntry.REFERENCES, FacetEntry.USED_BY, FacetEntry.USES,
				FacetEntry.HIERARCHY, FacetEntry.COMMENTS, FacetEntry.HISTORY,
			),
			full.rows.map { it.entry },
		)
		assertEquals("7", valueOf(full.rows, FacetEntry.MEMBERS))
		assertEquals("13 uses in 7 files", valueOf(full.rows, FacetEntry.REFERENCES))
		assertEquals("8 symbols, 1 file", valueOf(full.rows, FacetEntry.USED_BY))
		assertEquals("2 symbols", valueOf(full.rows, FacetEntry.USES))
		assertEquals("5", valueOf(full.rows, FacetEntry.COMMENTS))
		assertTrue(full.rows.filter { it.entry != FacetEntry.HISTORY }.all { it.opens })

		val empty = factRows(knowledge("interface", counts(uses = 1, useFiles = 1)), null, NOW) as FactRows.Counted
		assertEquals("none", valueOf(empty.rows, FacetEntry.MEMBERS))
		assertEquals("1 use", valueOf(empty.rows, FacetEntry.REFERENCES))
		assertEquals("none", valueOf(empty.rows, FacetEntry.USED_BY))
		assertEquals("none", valueOf(empty.rows, FacetEntry.USES))
		assertEquals("none", valueOf(empty.rows, FacetEntry.HIERARCHY))
		assertFalse(opensOf(empty.rows, FacetEntry.MEMBERS))
		assertTrue(opensOf(empty.rows, FacetEntry.REFERENCES))
	}

	@Test
	fun `a declaration that is not a type reads not a type`() {
		val rows = factRows(knowledge("method", counts(supertypes = 1, subtypes = 2)), null, NOW) as FactRows.Counted
		assertEquals("not a type", valueOf(rows.rows, FacetEntry.HIERARCHY))
		assertFalse(opensOf(rows.rows, FacetEntry.HIERARCHY))
	}

	@Test
	fun `an interface's subtypes read as implementations`() {
		val implementing = factRows(knowledge("interface", counts(subtypes = 3)), null, NOW) as FactRows.Counted
		assertEquals("3 implementations", valueOf(implementing.rows, FacetEntry.HIERARCHY))

		val descending = factRows(knowledge("class", counts(supertypes = 1, subtypes = 1)), null, NOW) as FactRows.Counted
		assertEquals("1 supertype, 1 subtype", valueOf(descending.rows, FacetEntry.HIERARCHY))
	}

	@Test
	fun `facts from an older plugin keep their numbers, read none at zero, and open nothing`() {
		val legacy = factRows(knowledge("interface", null), null, NOW) as FactRows.Legacy
		assertEquals(listOf("7", "13", "8", "2", "4"), legacy.rows.map { it.value })
		assertTrue(legacy.rows.none { it.opens })
		assertTrue(legacy.rows.none { it.entry == FacetEntry.HISTORY })
		assertNull(factRows(WorkspaceKnowledgeAnswer(symbolId = "s"), null, NOW))

		val nothing = WorkspaceKnowledgeFacts(
			members = 0,
			references = 0,
			fanIn = 0,
			fanOut = 0,
			supertypes = 0,
			subtypes = 0,
			comments = 0,
		)
		val empty = factRows(WorkspaceKnowledgeAnswer(symbolId = "s", facts = nothing), null, NOW) as FactRows.Legacy
		val counted = factRows(knowledge("interface", counts()), null, NOW) as FactRows.Counted
		assertTrue(empty.rows.all { it.value == valueOf(counted.rows, FacetEntry.MEMBERS) })
	}

	@Test
	fun `last changed reads the newest commit's age, and untracked, outside git and never committed each dim`() {
		fun changed(state: FacetState<WorkspaceFacetAnswer>?) =
			(factRows(knowledge("class", counts()), state, NOW) as FactRows.Counted).rows.single { it.entry == FacetEntry.HISTORY }

		val commits = history(
			"commits",
			listOf(commit("4b54a28", NOW - 12 * DAY_MS), commit("0ab0bd6", NOW - 28 * DAY_MS)),
		)
		assertEquals("12 days ago" to true, changed(FacetState.Shown(commits)).let { it.value to it.opens })
		assertEquals("untracked", changed(FacetState.Shown(history("untracked", emptyList()))).value)
		assertEquals("not in git", changed(FacetState.Shown(history("notRepository", emptyList()))).value)
		assertEquals("none", changed(FacetState.Shown(history("none", emptyList()))).value)
		assertEquals("unavailable", changed(FacetState.Unreachable).value)
		assertFalse(changed(null).opens)
	}
}
