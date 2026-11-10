package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.Protocol
import org.json.JSONArray
import org.json.JSONObject

/** Assistant action record kind. */
internal const val ASSISTANT_RECORD_KIND = "assistant_record"

private const val MINUTE_MS = 60_000L

private const val LISTED_RECORDS = 32

/** Missing notify means quiet. */
internal fun recordOf(entry: MailboxEntry): ActionRecord? {
	if (entry.kind != ASSISTANT_RECORD_KIND) return null
	val threads = entry.threads.orEmpty().map { RecordThread(it.threadId, it.title, it.url, it.outcome) }
	if (threads.isEmpty()) return null
	return ActionRecord(notify = entry.notify == true, threads = threads)
}

/** Record with no summary. */
internal fun Message.isQuietRecord(): Boolean = record?.notify == false

/** Quiet rows skip bursts, alerts, autoplay, and unread. */
internal fun Message.isQuiet(): Boolean = quiet || isQuietRecord()

/** Keyed by its head. */
internal data class ThreadRow(val messages: List<Message>, val fingerprint: Int, val threadCount: Int) {
	val head: Message get() = messages.first()
}

/** Consecutive quiet records fold. */
internal fun threadRows(messages: List<Message>, print: (Message) -> Int = { 0 }): List<ThreadRow> {
	val rows = ArrayList<ThreadRow>()
	var start = 0
	var hash = 0
	var threads = 0
	for ((i, m) in messages.withIndex()) {
		if (i > start && !(m.isQuietRecord() && messages[start].isQuietRecord())) {
			rows += ThreadRow(messages.subList(start, i), hash, threads)
			start = i
			hash = 0
			threads = 0
		}
		hash = 31 * hash + print(m)
		threads += m.record?.threads?.size ?: 0
	}
	if (messages.isNotEmpty()) rows += ThreadRow(messages.subList(start, messages.size), hash, threads)
	return rows
}

/** Quiet assistant sends and replies. */
internal fun quietInConversation(assistant: Boolean, message: Message): Boolean = assistant && message.isPeer

/** Titleless notice never alerts. */
internal fun quietNotice(kind: String, message: Message): Boolean = kind == NOTICE_ROW_KIND && message.title == null

private const val NOTICE_ROW_KIND = "notice"

/** The same state when nothing changes. */
internal fun ChatState.withAssistantPeersQuiet(): ChatState {
	var next = this
	for ((team, thread) in threads) {
		if (!isAssistant(this, team) || thread.none { quietInConversation(true, it) && !it.quiet }) continue
		val quieted = thread.map { if (quietInConversation(true, it)) it.copy(quiet = true) else it }
		next = next.copy(threads = next.threads + (team to quieted)).recomputeUnread(team, quieted)
	}
	return next
}

internal fun quietLine(threads: Int): String = "$threads cleared quietly"

internal fun outcomeLabel(outcome: String): String = when (outcome) {
	Protocol.Wire.RecordOutcome.RAN -> "Ran"
	Protocol.Wire.RecordOutcome.UNAVAILABLE -> "Unavailable"
	Protocol.Wire.RecordOutcome.REFUSED -> "Refused"
	Protocol.Wire.RecordOutcome.DONE -> "Done"
	Protocol.Wire.RecordOutcome.NOT_FOUND -> "Not found"
	Protocol.Wire.RecordOutcome.RATE_LIMITED -> "Rate limited"
	Protocol.Wire.RecordOutcome.UNCERTAIN -> "Uncertain"
	Protocol.Wire.RecordOutcome.NOT_ATTEMPTED -> "Not attempted"
	else -> "Unknown"
}

internal fun recordLabel(thread: RecordThread): String = thread.title ?: thread.threadId

/** Only HTTPS links open. */
internal fun recordHref(url: String?): String? = url?.takeIf { it.startsWith("https://") }

/** Lists newest records only. */
internal fun recordView(row: ThreadRow): JSONObject {
	val head = row.head
	val last = row.messages.last()
	val items = JSONArray()
	for (m in row.messages.takeLast(LISTED_RECORDS)) {
		for (thread in m.record?.threads.orEmpty()) {
			items.put(
				JSONObject()
					.put("label", recordLabel(thread))
					.putOpt("href", recordHref(thread.url))
					.put("outcome", outcomeLabel(thread.outcome)),
			)
		}
	}
	val view = JSONObject().put("quiet", head.isQuietRecord()).put("line", quietLine(row.threadCount)).put("items", items)
	val earlier = row.threadCount - items.length()
	if (earlier > 0) view.put("earlier", "$earlier earlier not listed")
	// Span once minutes differ.
	if (last.at / MINUTE_MS > head.at / MINUTE_MS) view.put("until", last.at)
	return view
}

internal fun recordJson(record: ActionRecord): JSONObject {
	val threads = JSONArray()
	for (thread in record.threads) {
		threads.put(
			JSONObject()
				.put("threadId", thread.threadId)
				.putOpt("title", thread.title)
				.putOpt("url", thread.url)
				.put("outcome", thread.outcome),
		)
	}
	return JSONObject().put("notify", record.notify).put("threads", threads)
}

/** Drop threads lacking IDs or outcomes. */
internal fun loadRecord(obj: JSONObject): ActionRecord? {
	val arr = obj.optJSONArray("threads") ?: return null
	val threads = (0 until arr.length()).mapNotNull { index ->
		val thread = arr.optJSONObject(index) ?: return@mapNotNull null
		val threadId = thread.optString("threadId").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
		val outcome = thread.optString("outcome").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
		RecordThread(
			threadId,
			thread.optString("title").takeIf { it.isNotEmpty() },
			thread.optString("url").takeIf { it.isNotEmpty() },
			outcome,
		)
	}
	return if (threads.isEmpty()) null else ActionRecord(obj.optBoolean("notify"), threads)
}
