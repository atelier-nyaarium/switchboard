package com.atelier_nyaarium.switchboard

import android.app.Notification
import android.app.RemoteInput
import com.atelier_nyaarium.switchboard.proto.PhoneNotification
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal fun notificationTextOf(extras: Map<String, CharSequence?>): Pair<String?, String?> =
	cleanNotificationText(extras[Notification.EXTRA_TITLE], 200) to
		(cleanNotificationText(extras[Notification.EXTRA_TEXT], 500)
			?: cleanNotificationText(extras[Notification.EXTRA_BIG_TEXT], 500))

private fun cleanNotificationText(value: CharSequence?, limit: Int): String? =
	value?.toString()?.trim()?.take(limit)?.takeIf(String::isNotEmpty)

internal fun keepsNotification(packageName: String, ownPackage: String, flags: Int): Boolean =
	packageName != ownPackage &&
		(flags and Notification.FLAG_GROUP_SUMMARY) == 0 &&
		(flags and Notification.FLAG_ONGOING_EVENT) == 0

internal fun selectNotifications(
	entries: Iterable<NotificationEntry>,
	query: String?,
	limit: Long?,
): List<NotificationEntry> = entries
	.filter { appMatches(it.appLabel, it.packageName, query) }
	.sortedByDescending { it.postedAt }
	.take((limit ?: 10L).coerceIn(1L, 30L).toInt())

internal fun replyInputOf(entry: NotificationEntry): RemoteInput? =
	entry.takeIf { it.showing }?.replyAction?.remoteInputs?.firstOrNull { it.allowFreeFormInput }

internal fun replyable(entry: NotificationEntry): Boolean = replyInputOf(entry) != null

internal fun notificationOf(entry: NotificationEntry, zone: ZoneId): PhoneNotification = PhoneNotification(
	entry.key.take(120),
	entry.appLabel.take(80),
	entry.packageName.take(120),
	entry.title?.take(200),
	entry.text?.take(500),
	Instant.ofEpochMilli(entry.postedAt).atZone(zone).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
	replyable(entry),
)

internal fun validReplyRequest(id: String, text: String): Boolean = id.length in 1..120 && text.length in 1..1000

internal fun notificationEntryOf(
	key: String,
	packageName: String,
	ownPackage: String,
	appLabel: String,
	flags: Int,
	extras: Map<String, CharSequence?>,
	postedAt: Long,
	actions: Array<Notification.Action>?,
): NotificationEntry? {
	if (!keepsNotification(packageName, ownPackage, flags)) return null
	val (title, text) = notificationTextOf(extras)
	val replyAction = actions?.firstOrNull { action -> action.remoteInputs?.any { it.allowFreeFormInput } == true }
	return NotificationEntry(
		key = key.take(120),
		packageName = packageName.take(120),
		appLabel = appLabel.take(80),
		title = title,
		text = text,
		postedAt = postedAt,
		showing = true,
		replyAction = replyAction,
	)
}
