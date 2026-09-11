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

/** A data-plane consumer of new inbound messages, invoked once per message at the drain gate. */
fun interface InboundSubscriber {
	fun onMessage(team: String, msg: Message)
}

/** A consumer of arrived `plugin_action` mailbox entries, invoked once per entry at the drain gate.
 * Deliberately carries no plugin types: the plugin-framework bridge maps these fields onto its own
 * claim-keyed dispatch. */
fun interface PluginActionSubscriber {
	fun onAction(team: String, pluginId: String, actionType: String, payload: JsonObject?)
}
