package com.atelier_nyaarium.switchboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Notification actions that work without the Activity: a swipe marks the team read, and Play queues
 * the burst-last message. Unread is a persisted read anchor, so mark-read survives a process death.
 */
class NotificationReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action == ACTION_STATUS_DISMISSED) {
			SwitchboardService.statusDismissed = true
			return
		}
		// Transport buttons act on the RUN, not on a message, so they carry no team or `at` and must
		// be handled before the extras below are required.
		val repo = Repo.get(context)
		when (intent.action) {
			SttsTransport.ACTION_PLAY -> return repo.command { playback.resumePlayback() }
			SttsTransport.ACTION_PAUSE -> return repo.command { playback.pausePlayback() }
			SttsTransport.ACTION_SKIP -> return repo.command { playback.skipPlayback() }
		}
		if (intent.action == ACTION_DISMISS_ROUTINE_MISS) {
			val gatewayId = intent.getStringExtra(EXTRA_GATEWAY) ?: return
			val routineId = intent.getStringExtra(EXTRA_ROUTINE) ?: return
			val occurrenceId = intent.getStringExtra(EXTRA_OCCURRENCE) ?: return
			return repo.command { routineOps.dismiss(routineId, occurrenceId, gatewayId) }
		}
		// A vault notification answers nothing from here; every answer lives in the sheet.
		if (intent.hasExtra(SwitchboardService.EXTRA_VAULT_REQUEST)) return
		val team = intent.getStringExtra(SwitchboardService.EXTRA_OPEN_TEAM)?.let(repo::fromCanonical) ?: return
		val at = intent.getLongExtra(SwitchboardService.EXTRA_MESSAGE_AT, -1L)
		when (intent.action) {
			ACTION_MARK_READ -> repo.markRead(team)
			// Queued rather than played directly, like the in-thread tap: a playback outside the queue
			// is invisible to the row, the bubble and the lockscreen, all three of which report what the
			// queue is doing. It also stops a notification tap racing a run already in progress.
			ACTION_PLAY_FULL ->
				if (at > 0) {
					repo.command { playback.enqueueForPlay(team, at, SttsPlayer.Tier.FULL, announceRun = false, requireFollowed = false) }
				}
			ACTION_PLAY_SUMMARY ->
				if (at > 0) {
					repo.command { playback.enqueueForPlay(team, at, SttsPlayer.Tier.SUMMARY, announceRun = false, requireFollowed = false) }
				}
		}
	}

	companion object {
		const val ACTION_MARK_READ = "com.atelier_nyaarium.switchboard.MARK_READ"
		const val ACTION_PLAY_FULL = "com.atelier_nyaarium.switchboard.PLAY_FULL"
		const val ACTION_PLAY_SUMMARY = "com.atelier_nyaarium.switchboard.PLAY_SUMMARY"
		const val ACTION_STATUS_DISMISSED = "com.atelier_nyaarium.switchboard.STATUS_DISMISSED"
		const val ACTION_DISMISS_ROUTINE_MISS = "com.atelier_nyaarium.switchboard.DISMISS_ROUTINE_MISS"
		const val EXTRA_GATEWAY = "gateway"
		const val EXTRA_ROUTINE = "routine"
		const val EXTRA_OCCURRENCE = "occurrence"
	}
}
