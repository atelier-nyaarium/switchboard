package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_800_000_000_000L

private const val DAY_MS = 86_400_000L

class FacetHistoryRulesTest {
	private fun commit(hash: String, atMillis: Long) =
		WorkspaceHistoryCommit(hash = hash, at = atMillis / 1_000, subject = "did a thing", added = 4, removed = 1)

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
	fun `history lists newest first with short hashes and ages, and says untracked, outside git or none`() {
		val body = historyBody(
			"commits",
			listOf(commit("4b54a28cafe", NOW - 12 * DAY_MS), commit("0ab0bd6beef", NOW - 28 * DAY_MS)),
			truncated = true,
			now = NOW,
		) as HistoryBody.Commits
		assertEquals(listOf("4b54a28", "0ab0bd6"), body.items.map { it.shortHash })
		assertEquals(listOf("12 days ago", "4 weeks ago"), body.items.map { it.age })
		// The plugin's cap, never the rows this answer happened to carry.
		assertEquals(2, body.items.size)
		assertEquals(HISTORY_COMMIT_CAP, body.stoppedAt)

		val whole = historyBody("commits", listOf(commit("4b54a28cafe", NOW)), truncated = false, now = NOW)
		assertNull((whole as HistoryBody.Commits).stoppedAt)

		assertTrue(historyBody("untracked", emptyList(), false, NOW) is HistoryBody.Empty)
		assertTrue(historyBody("notRepository", emptyList(), false, NOW) is HistoryBody.Empty)
		assertTrue(historyBody("commits", emptyList(), false, NOW) is HistoryBody.Empty)
		assertEquals("localAgentSession.ts, lines 26-43", historySubtitle("src/mcp/local/localAgentSession.ts", 26, 43))
		assertEquals("localAgentSession.ts, line 26", historySubtitle("src/mcp/local/localAgentSession.ts", 26, 26))
	}

	@Test
	fun `file stats read the time since the last change, commits over their span, and lines added and removed`() {
		val stats = (fileStrip(fileHistory("commits", truncated = false), NOW) as FileStrip.Stats).stats
		assertEquals("12 days", stats.sinceLast)
		assertEquals("3", stats.commits)
		assertEquals("commits in 4 weeks", stats.commitsLabel)
		assertEquals("+67" to "-24", stats.added to stats.removed)

		assertEquals("3+", (fileStrip(fileHistory("commits", truncated = true), NOW) as FileStrip.Stats).stats.commits)
		assertTrue(fileStrip(fileHistory("untracked", truncated = false), NOW) is FileStrip.Line)
	}
}
