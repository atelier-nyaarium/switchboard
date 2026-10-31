package com.atelier_nyaarium.switchboard.plugins.assistant

import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.gatewayOf
import com.atelier_nyaarium.switchboard.plugins.AccountWipeHandler
import com.atelier_nyaarium.switchboard.plugins.PluginActionHandler
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.ThreadForgetHandler
import com.atelier_nyaarium.switchboard.proto.AssistantSendRequest
import com.atelier_nyaarium.switchboard.proto.AssistantSendRetract
import com.atelier_nyaarium.switchboard.proto.AssistantActRequest
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.decodeFromJsonElement

/** Built-in send approval handler. */
class AssistantPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		val repo = Repo.get(host.applicationContext)
		host.pluginActions.claim("assistant:send-request", PluginActionHandler { action ->
			val payload = action.payload ?: return@PluginActionHandler
			val request = runIsolated {
				wireJson.decodeFromJsonElement(AssistantSendRequest.serializer(), payload)
			}.getOrNull() ?: return@PluginActionHandler
			val gatewayId = runIsolated { gatewayOf(action.team) }.getOrNull() ?: return@PluginActionHandler
			repo.assistantSendOps.onRequest(gatewayId, action.team, request)
		})
		host.pluginActions.claim("assistant:send-retract", PluginActionHandler { action ->
			val payload = action.payload ?: return@PluginActionHandler
			val retract = runIsolated {
				wireJson.decodeFromJsonElement(AssistantSendRetract.serializer(), payload)
			}.getOrNull() ?: return@PluginActionHandler
			val gatewayId = runIsolated { gatewayOf(action.team) }.getOrNull() ?: return@PluginActionHandler
			repo.assistantSendOps.onRetract(gatewayId, retract.requestId)
		})
		host.pluginActions.claim("assistant:act-request", PluginActionHandler { action ->
			val payload = action.payload ?: return@PluginActionHandler
			val request = runIsolated {
				wireJson.decodeFromJsonElement(AssistantActRequest.serializer(), payload)
			}.getOrNull() ?: return@PluginActionHandler
			val gatewayId = runIsolated { gatewayOf(action.team) }.getOrNull() ?: return@PluginActionHandler
			repo.assistantActOps.onRequest(gatewayId, action.team, request)
		})
		host.pluginActions.claim("assistant:act-retract", PluginActionHandler { action ->
			val payload = action.payload ?: return@PluginActionHandler
			val retract = runIsolated {
				wireJson.decodeFromJsonElement(AssistantSendRetract.serializer(), payload)
			}.getOrNull() ?: return@PluginActionHandler
			val gatewayId = runIsolated { gatewayOf(action.team) }.getOrNull() ?: return@PluginActionHandler
			repo.assistantActOps.onRetract(gatewayId, retract.requestId)
		})
		host.threadForgetHandlers.claim("assistant:send-forget", ThreadForgetHandler { _, team ->
			repo.assistantSendOps.forgetTeam(team)
			repo.assistantActOps.forgetTeam(team)
		})
		host.accountWipeHandlers.claim("assistant:send-wipe", AccountWipeHandler {
			repo.assistantSendOps.clearRequests()
			repo.assistantActOps.clearRequests()
		})
	}
}
