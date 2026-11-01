package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Functions & Helpers

/** Gates burst alerts. */
internal fun shouldNotifyBurst(
	isVisible: Boolean,
	canNotify: Boolean,
	closedTeams: Set<String>,
	team: String,
	hold: com.atelier_nyaarium.switchboard.proto.PhoneHold?,
	self: HoldSelf?,
	now: Long = System.currentTimeMillis(),
): Boolean {
	val todayRule = !isVisible && canNotify && team !in closedTeams
	return alertsFor(hold, self, now, isVisible, todayRule)
}

internal enum class TeamNotificationAction { CANCEL, SILENT_REFRESH, LEAVE }

internal fun teamNotificationAction(
	showing: Boolean,
	unreadCount: Int,
	heldByAnother: Boolean,
	closed: Boolean,
): TeamNotificationAction = when {
	!showing -> TeamNotificationAction.LEAVE
	heldByAnother || closed || unreadCount <= 0 -> TeamNotificationAction.CANCEL
	else -> TeamNotificationAction.SILENT_REFRESH
}
