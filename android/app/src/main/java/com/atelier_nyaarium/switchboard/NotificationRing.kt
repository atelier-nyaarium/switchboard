package com.atelier_nyaarium.switchboard

import android.app.Notification

internal data class NotificationEntry(
	val key: String,
	val packageName: String,
	val appLabel: String,
	val title: String?,
	val text: String?,
	val postedAt: Long,
	val showing: Boolean,
	val replyAction: Notification.Action?,
)

internal class NotificationRing(private val capacity: Int = CAPACITY) {
	private val entries = LinkedHashMap<String, NotificationEntry>()

	@Synchronized
	fun update(key: String, entry: NotificationEntry?) {
		val ringKey = key.take(120)
		entries.remove(ringKey)
		if (entry == null) return
		entries[ringKey] = if (entry.showing) entry else entry.copy(replyAction = null)
		while (entries.size > capacity) entries.remove(evictionKey())
	}

	/** Dismissed rows go first. */
	private fun evictionKey(): String = entries.values.firstOrNull { !it.showing }?.key ?: entries.keys.first()

	@Synchronized
	fun remove(key: String) {
		val ringKey = key.take(120)
		entries[ringKey]?.let { entries[ringKey] = it.copy(showing = false, replyAction = null) }
	}

	/** Rows absent are dismissed. */
	@Synchronized
	fun reconcile(showingKeys: Set<String>) {
		val keep = showingKeys.mapTo(HashSet()) { it.take(120) }
		for (ringKey in entries.keys.toList()) {
			val entry = entries.getValue(ringKey)
			if (entry.showing && ringKey !in keep) entries[ringKey] = entry.copy(showing = false, replyAction = null)
		}
	}

	@Synchronized
	fun all(): List<NotificationEntry> = entries.values.toList()

	@Synchronized
	fun <T> withEntry(key: String, block: (NotificationEntry?) -> T): T = block(entries[key.take(120)])

	companion object {
		const val CAPACITY = 100
		val shared = NotificationRing()
	}
}
