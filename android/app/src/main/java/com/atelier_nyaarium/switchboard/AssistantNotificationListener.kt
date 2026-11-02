package com.atelier_nyaarium.switchboard

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class AssistantNotificationListener : NotificationListenerService() {
	override fun onListenerConnected() {
		val active = activeNotifications.orEmpty()
		active.forEach(::postNotification)
		NotificationRing.shared.reconcile(active.mapTo(HashSet()) { it.key })
	}

	/** Nothing is known until reconnect. */
	override fun onListenerDisconnected() {
		NotificationRing.shared.reconcile(emptySet())
	}

	override fun onNotificationPosted(sbn: StatusBarNotification) {
		postNotification(sbn)
	}

	override fun onNotificationRemoved(sbn: StatusBarNotification) {
		NotificationRing.shared.remove(sbn.key)
	}

	private fun postNotification(sbn: StatusBarNotification) {
		val notification = sbn.notification
		val appLabel = runIsolated {
			packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
		}.getOrDefault(sbn.packageName)
		val extras = notification.extras
		val entry = notificationEntryOf(
			key = sbn.key,
			packageName = sbn.packageName,
			ownPackage = packageName,
			appLabel = appLabel,
			flags = notification.flags,
			extras = mapOf(
				Notification.EXTRA_TITLE to extras.getCharSequence(Notification.EXTRA_TITLE),
				Notification.EXTRA_TEXT to extras.getCharSequence(Notification.EXTRA_TEXT),
				Notification.EXTRA_BIG_TEXT to extras.getCharSequence(Notification.EXTRA_BIG_TEXT),
			),
			postedAt = sbn.postTime,
			actions = notification.actions,
		)
		NotificationRing.shared.update(sbn.key, entry)
	}
}
