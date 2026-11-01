package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget

////////////////////////////////
//  Interfaces & Types

/** Epochs are unordered. */
data class ReadAnchor(val epoch: Long, val seq: Long, val at: Long)

internal fun conversationStream(team: String): String = team

internal fun scheduledResultsStream(team: String): String = "scheduled:$team"

internal fun isConversationStream(stream: String): Boolean =
	runIsolated { parseQualifiedTarget(stream) }.isSuccess

internal fun anchorPositionAtOrAfter(anchor: ReadAnchor, position: ReadAnchor): Boolean =
	if (anchor.epoch == position.epoch) anchor.seq >= position.seq else anchor.at >= position.at

internal fun mergeStreamAnchor(current: ReadAnchor?, candidate: ReadAnchor): ReadAnchor = when {
	current == null -> candidate
	current.epoch == candidate.epoch && candidate.seq > current.seq -> candidate
	current.epoch == candidate.epoch && candidate.seq == current.seq && candidate.at > current.at -> candidate
	current.epoch != candidate.epoch && candidate.at > current.at -> candidate
	else -> current
}

internal fun shouldCancelScheduledFailureNotification(
	team: String,
	readAnchors: Map<String, ReadAnchor>,
	failure: ReadAnchor,
): Boolean = readAnchors[scheduledResultsStream(team)]?.let { anchorPositionAtOrAfter(it, failure) } == true

internal interface ReadAnchorSync {
	suspend fun reportLocalReadAdvances()
	fun retryPendingReadAnchor(stream: String)
}

////////////////////////////////
//  Functions & Helpers

/** Sent echoes stay read. */
internal fun Message.countsUnread(): Boolean = !fromMe && seq > 0L && !isQuiet()

/** Resolve anchors by arrival. */
internal fun anchorIndex(thread: List<Message>, anchor: ReadAnchor?): Int {
	if (anchor == null) return -1
	return thread.indexOfFirst { it.epoch == anchor.epoch && it.seq == anchor.seq }
}

/** Inbound rows positioned strictly after the anchor's row. */
internal fun unreadCount(thread: List<Message>, anchor: ReadAnchor?): Int {
	val idx = anchorIndex(thread, anchor)
	return thread.withIndex().count { (i, m) -> i > idx && m.countsUnread() }
}

/** The unread rows themselves, in thread order. The notification's preview lines and Play actions
 * derive from this rather than a stale burst list, so a mid-drain refresh stays accurate. */
internal fun unreadRows(thread: List<Message>, anchor: ReadAnchor?): List<Message> {
	val idx = anchorIndex(thread, anchor)
	return thread.filterIndexed { i, m -> i > idx && m.countsUnread() }
}

internal fun firstUnreadId(thread: List<Message>, anchor: ReadAnchor?): Long? {
	val idx = anchorIndex(thread, anchor)
	return thread.withIndex().firstOrNull { (i, m) -> i > idx && m.countsUnread() }?.value?.id
}

/** Resolve a reported "read up to" row to the anchor it implies: the row itself if it counts, else
 * the nearest earlier inbound row, so a reported pending send still marks everything above it read.
 * The `at` check stops an id reused after a forget sweep from wrongly crediting. */
internal fun resolveReportedAnchor(thread: List<Message>, rowId: Long, reportedAt: Long): ReadAnchor? {
	val idx = thread.indexOfFirst { it.id == rowId }
	if (idx < 0 || thread[idx].at != reportedAt) return null
	for (i in idx downTo 0) {
		val m = thread[i]
		if (m.countsUnread()) return ReadAnchor(m.epoch, m.seq, m.at)
	}
	return null
}

/** The anchor a deliberate mark-read (a notification swipe-away) advances to. */
internal fun lastInboundAnchor(thread: List<Message>): ReadAnchor? =
	thread.lastOrNull { it.countsUnread() }?.let { ReadAnchor(it.epoch, it.seq, it.at) }

/** Whether `candidate` is a genuine advance over `current`. An unresolvable `current` is index -1,
 * so a receipt for any resolvable row always advances and nothing deadlocks. */
internal fun isAnchorAdvance(thread: List<Message>, current: ReadAnchor?, candidate: ReadAnchor): Boolean {
	val candidateIdx = thread.indexOfFirst { it.epoch == candidate.epoch && it.seq == candidate.seq }
	if (candidateIdx < 0) return false
	return candidateIdx > anchorIndex(thread, current)
}

internal fun mergeReadAnchor(thread: List<Message>, current: ReadAnchor?, candidate: ReadAnchor): ReadAnchor? =
	candidate.takeIf { isAnchorAdvance(thread, current, it) } ?: current

internal fun mergedReadAnchorReported(current: ReadAnchor?, remote: ReadAnchor, merged: ReadAnchor): ReadAnchor? = when {
	current == null || merged == remote -> merged
	current.epoch == remote.epoch && current.seq == remote.seq -> merged
	else -> null
}

/** Re-anchor a sibling thread whose anchor row [threadsAfterForget] swept away. Falls back by `at`
 * rather than by position, since the removed row's position no longer exists in `newThread`. */
internal fun reanchorAfterForget(newThread: List<Message>, anchor: ReadAnchor?): ReadAnchor? {
	if (anchor == null || anchorIndex(newThread, anchor) >= 0) return anchor
	return newThread.lastOrNull { it.countsUnread() && it.at <= anchor.at }?.let { ReadAnchor(it.epoch, it.seq, it.at) }
}

/** Teams whose local anchor has advanced past what this device last reported to the read-anchor sync
 * plane. A team absent from `lastReported` needs reporting only if its current anchor differs. */
internal fun streamsNeedingReadReport(readAnchors: Map<String, ReadAnchor>, lastReported: Map<String, ReadAnchor>): List<String> =
	readAnchors.filter { (stream, anchor) ->
		val already = lastReported[stream]
		already == null || already.epoch != anchor.epoch || already.seq != anchor.seq
	}.keys.toList()
