package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.JsonObject

////////////////////////////////
//  Interfaces & Types

/**
 * A send the Router fires at its wall-clock time, at most one per team.
 *
 * Until the Router accepts it, `routerVersion` is null and the record is an intent the drain keeps
 * posting under the same `opId`. `replacesVersion` names the accepted record a reschedule supersedes.
 * `cancelRequested` is a cancel the Router has not answered yet; `draftTaken` says the composer
 * already holds the text and files, so a settled cancel must not delete them.
 */
data class ScheduledSend(
	val text: String,
	val fileRefs: List<MessageFile>,
	val fireAtMillis: Long,
	val opId: String,
	val targetDomainId: String?,
	val createdAt: Long,
	val routerVersion: Long? = null,
	val replacesVersion: Long? = null,
	val cancelRequested: Boolean = false,
	val draftTaken: Boolean = false,
)

/** What a scheduled send's dock says; `acts` gates its edit and its X. */
internal data class ScheduledDockText(val headline: String, val detail: String, val acts: Boolean)

internal fun scheduledDockText(rec: ScheduledSend, now: Long, zone: java.time.ZoneId): ScheduledDockText = when {
	rec.cancelRequested -> ScheduledDockText("Cancelling", "Waiting for the Router", acts = false)
	scheduledSending(rec, now) -> ScheduledDockText("Sending", "Waiting for the Router to confirm", acts = false)
	rec.routerVersion == null -> ScheduledDockText("Waiting for the Router", "Edit or cancel anytime", acts = true)
	else -> ScheduledDockText("Sending at ${absoluteTimeText(rec.fireAtMillis, zone)}", countdownText(rec.fireAtMillis - now), acts = true)
}

/** Why the schedule dialog cannot take this pick, or null. */
internal fun scheduleBlocker(pickedMillis: Long?, now: Long, fileCount: Int): String? = when {
	fileCount > com.atelier_nyaarium.switchboard.proto.Protocol.CHANNEL_FILES_MAX ->
		scheduleFilesLine(com.atelier_nyaarium.switchboard.proto.Protocol.CHANNEL_FILES_MAX)
	pickedMillis == null || pickedMillis <= now + 60_000 -> Line.PICK_LATER.text
	pickedMillis - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS -> Line.PICK_SOONER.text
	else -> null
}

/** A minute, or sooner when the fire time comes first. */
internal fun nextDockTick(rec: ScheduledSend, now: Long): Long =
	(rec.fireAtMillis - now).takeIf { it > 0 }?.coerceAtMost(60_000L) ?: 60_000L

/** A data-plane consumer of new inbound messages, invoked once per message at the drain gate. */
fun interface InboundSubscriber {
	fun onMessage(team: String, msg: Message)
}

/** A consumer of arrived `plugin_action` mailbox entries, invoked once per entry at the drain gate.
 * Deliberately carries no plugin types: the plugin-framework bridge maps these fields onto its own
 * claim-keyed dispatch. */
fun interface PluginActionSubscriber {
	fun onAction(
		team: String,
		pluginId: String,
		actionType: String,
		payload: JsonObject?,
		stamp: com.atelier_nyaarium.switchboard.proto.RowStamp?,
	)
}
