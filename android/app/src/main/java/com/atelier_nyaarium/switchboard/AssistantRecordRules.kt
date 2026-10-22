package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import org.json.JSONArray
import org.json.JSONObject

/** Assistant action record kind. */
internal const val ASSISTANT_RECORD_KIND = "assistant_record"

/** Missing notify means quiet. */
internal fun recordOf(entry: MailboxEntry): ActionRecord? {
	if (entry.kind != ASSISTANT_RECORD_KIND) return null
	val threads = entry.threads.orEmpty().map { RecordThread(it.threadId, it.title, it.url, it.outcome) }
	if (threads.isEmpty()) return null
	return ActionRecord(notify = entry.notify == true, threads = threads)
}

/** Quiet records skip burst, alerts, autoplay, unread. */
internal fun Message.isQuietRecord(): Boolean = record?.notify == false

/** Count every thread. */
internal fun quietLine(record: ActionRecord): String = "${record.threads.size} cleared quietly"

internal fun outcomeLabel(outcome: String): String = when (outcome) {
	"done" -> "Done"
	"not_found" -> "Not found"
	"rate_limited" -> "Rate limited"
	"uncertain" -> "Uncertain"
	"not_attempted" -> "Not attempted"
	else -> "Unknown"
}

internal fun recordLabel(thread: RecordThread): String = thread.title ?: thread.threadId

/** Only HTTPS links open. */
internal fun recordHref(url: String?): String? = url?.takeIf { it.startsWith("https://") }

/** Decide presentation before rendering. */
internal fun recordView(record: ActionRecord): JSONObject {
	val items = JSONArray()
	for (thread in record.threads) {
		items.put(
			JSONObject()
				.put("label", recordLabel(thread))
				.putOpt("href", recordHref(thread.url))
				.put("outcome", outcomeLabel(thread.outcome)),
		)
	}
	return JSONObject().put("quiet", !record.notify).put("line", quietLine(record)).put("items", items)
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
