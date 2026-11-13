package com.atelier_nyaarium.switchboard

/** Told of a cut once it is on disk: the rows cleared and the rows left. */
fun interface ThreadCutSubscriber {
	fun onCut(team: String, rows: List<Message>, left: List<Message>)
}

/** Extra items a cut takes. */
data class CutClaim(val count: Int, val noun: String)

/** One thread cleared through a pressed row, phone only. `silenced`: `at`s no surviving row shares. */
internal data class ThreadCut(
	val team: String,
	val rows: List<Message>,
	val left: List<Message>,
	val freed: List<String>,
	val silenced: Set<Long>,
)

/**
 * Rows through the pressed one, and files nothing else names; a pending send keeps its own.
 * Null when the row is gone. The anchor stays, so later rows stay unread.
 */
internal fun threadCut(state: ChatState, team: String, rowId: Long, rowAt: Long): ThreadCut? {
	val thread = state.threads[team] ?: return null
	val pressed = thread.indexOfFirst { it.id == rowId && it.at == rowAt }.takeIf { it >= 0 } ?: return null
	val rows = thread.subList(0, pressed + 1)
	val left = thread.drop(rows.size)
	val kept = state.threads.flatMap { (t, msgs) -> if (t == team) left else msgs } + rows.filter { it.fromMe && it.status == "pending" }
	val named = state.namedSrcs(kept)
	val freed = rows.flatMap { it.files }.mapNotNull { it.src }.distinct().filterNot { it in named }
	return ThreadCut(team, rows, left, freed, rows.map { it.at }.toSet() - left.map { it.at }.toSet())
}

/** The row a clear above the pressed one runs through; the pressed row stays. Null when none is above. */
internal fun rowAbove(state: ChatState, team: String, rowId: Long, rowAt: Long): Message? {
	val thread = state.threads[team] ?: return null
	val pressed = thread.indexOfFirst { it.id == rowId && it.at == rowAt }
	return if (pressed > 0) thread[pressed - 1] else null
}

/** Files these rows, drafts or scheduled sends name. */
internal fun ChatState.namedSrcs(rows: List<Message>): Set<String> = (
	rows.flatMap { it.files } +
		drafts.values.flatMap { it.files } +
		scheduledSends.values.flatMap { it.fileRefs }
	).mapNotNull { it.src }.toSet()

/** Freed files still on disk, and their bytes. */
internal data class FreedSize(val files: Int, val bytes: Long)

internal fun freedSize(filesDir: java.io.File, freed: List<String>): FreedSize {
	val held = freed.mapNotNull { Attachments.fileFor(filesDir, it) }
	return FreedSize(held.size, held.sumOf { it.length() })
}

/** Cut rows gone; their ids never minted again. */
internal fun ChatState.withCut(cut: ThreadCut): ChatState {
	val next = threads[cut.team].orEmpty().drop(cut.rows.size)
	val floor = maxOf(idFloors[cut.team] ?: -1L, cut.rows.maxOf { it.id })
	val unechoed = cut.rows.filter { it.fromMe && it.seq == 0L }.mapNotNull { it.opId }
	return copy(
		threads = threads + (cut.team to next),
		idFloors = idFloors + (cut.team to floor),
		clearedSends = clearedSends + unechoed,
	).recomputeUnread(cut.team, next)
}

/** The state once a cut send's echo is dropped; null when no cut names it. */
internal fun ChatState.swallowEcho(echo: Message): ChatState? =
	echo.opId?.takeIf { it in clearedSends }?.let { copy(clearedSends = clearedSends - it) }

/** Above every held or retired id. */
internal fun nextRowId(thread: List<Message>, floor: Long?): Long = maxOf(thread.maxOfOrNull { it.id } ?: -1L, floor ?: -1L) + 1

/** Omits zero counts. */
internal fun clearConfirmLines(rows: Int, files: Int, bytes: Long, claims: List<CutClaim> = emptyList()): List<String> =
	listOf("This will clear the messages above this one from this phone. The session will remain untouched.") +
		clearCountLines(rows, files, bytes, claims)

/** What a clear takes, one line each; zero counts omitted. */
internal fun clearCountLines(rows: Int, files: Int, bytes: Long, claims: List<CutClaim> = emptyList()): List<String> =
	listOfNotNull(countLine(rows, "message"), countLine(files, "file")) +
		claims.mapNotNull { countLine(it.count, it.noun) } +
		listOfNotNull(recoveredLine(bytes))

private fun countLine(count: Int, noun: String): String? = when (count) {
	0 -> null
	1 -> "- 1 $noun"
	else -> "- $count ${noun}s"
}

private fun recoveredLine(bytes: Long): String? {
	if (bytes <= 0L) return null
	val (amount, unit) = when {
		bytes >= 1L shl 30 -> bytes / (1L shl 30).toDouble() to "GB"
		bytes >= 1L shl 20 -> bytes / (1L shl 20).toDouble() to "MB"
		bytes >= 1L shl 10 -> bytes / (1L shl 10).toDouble() to "KB"
		else -> bytes.toDouble() to "bytes"
	}
	return "- ~${Math.round(amount).coerceAtLeast(1)} $unit recovered"
}
