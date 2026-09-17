package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit

/** What git says about a symbol or a file: the commits, what a bare outcome reads as, and the strip. */

private const val UNKNOWN = "unknown"

private const val HISTORY_NONE = "none"

internal const val HISTORY_COMMITS = "commits"

internal const val HISTORY_UNTRACKED = "untracked"

internal const val HISTORY_NOT_REPOSITORY = "notRepository"

internal data class CommitItem(val key: String, val shortHash: String, val subject: String, val age: String)

/** Where the plugin stops a symbol's history. Pinned to its own bound by a residue test. */
internal const val HISTORY_COMMIT_CAP = 200

internal sealed interface HistoryBody {
	/** `stoppedAt` is the cap the plugin cut at, never the rows it happened to answer with. */
	data class Commits(val items: List<CommitItem>, val stoppedAt: Int?) : HistoryBody

	data class Empty(val text: String) : HistoryBody
}

internal fun historyBody(
	outcome: String,
	commits: List<WorkspaceHistoryCommit>,
	truncated: Boolean,
	now: Long,
): HistoryBody {
	if (outcome != HISTORY_COMMITS || commits.isEmpty()) return HistoryBody.Empty(historyWords(outcome))
	return HistoryBody.Commits(
		commits.map { CommitItem(it.hash, it.hash.take(7), it.subject, agoText(it.at * 1_000, now)) },
		HISTORY_COMMIT_CAP.takeIf { truncated },
	)
}

private fun historyWords(outcome: String): String =
	when (outcome) {
		HISTORY_UNTRACKED -> "Untracked"
		HISTORY_NOT_REPOSITORY -> "Not a repository"
		HISTORY_COMMITS, HISTORY_NONE -> "No commits"
		else -> "No history"
	}

internal fun historySubtitle(module: String, startLine: Long, endLine: Long): String {
	val file = module.substringAfterLast('/')
	return if (startLine == endLine) "$file, line $startLine" else "$file, lines $startLine-$endLine"
}

internal data class FileStats(
	val sinceLast: String,
	val commits: String,
	val commitsLabel: String,
	val added: String,
	val removed: String,
)

internal sealed interface FileStrip {
	data class Stats(val stats: FileStats) : FileStrip

	data class Line(val text: String) : FileStrip
}

internal fun fileStrip(answer: WorkspaceFileHistoryAnswer, now: Long): FileStrip {
	if (answer.outcome != HISTORY_COMMITS) return FileStrip.Line(historyWords(answer.outcome))
	return FileStrip.Stats(
		FileStats(
			sinceLast = answer.lastTouched?.let { spanText(now - it * 1_000) } ?: UNKNOWN,
			commits = "${answer.count}" + if (answer.truncated) "+" else "",
			commitsLabel = answer.firstSeen?.let { "commits in ${spanText(now - it * 1_000)}" } ?: HISTORY_COMMITS,
			added = "+${answer.added}",
			removed = "-${answer.removed}",
		),
	)
}
