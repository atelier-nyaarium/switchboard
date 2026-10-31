package com.atelier_nyaarium.switchboard.plugins.phone

import com.atelier_nyaarium.switchboard.CapabilityLog
import com.atelier_nyaarium.switchboard.CapabilityLogEvent
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.gatewayOf
import com.atelier_nyaarium.switchboard.plugins.PluginAction
import com.atelier_nyaarium.switchboard.plugins.PluginActionHandler
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityRow
import com.atelier_nyaarium.switchboard.proto.RowStamp
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.validPhoneCapabilityRow
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive

/** Unstamped is nobody's. */
internal fun stampedFor(stamp: RowStamp?, device: String): Boolean = stamp != null && stamp.device == device

class PhonePlugin : PluginEntry {
	override fun register(host: PluginHost) {
		val repo = Repo.get(host.applicationContext)
		host.pluginActions.claim("phone:capability", PluginActionHandler { action -> onCapability(repo, action) })
		host.pluginActions.claim("phone:retract", PluginActionHandler { action -> onRetract(repo, action) })
	}

	private fun onCapability(repo: com.atelier_nyaarium.switchboard.ChatRepository, action: PluginAction) {
		val payload = action.payload ?: return
		val row = runIsolated { wireJson.decodeFromJsonElement(PhoneCapabilityRow.serializer(), payload) }.getOrNull()
			?.takeIf(::validPhoneCapabilityRow) ?: return
		val device = repo.readyOrNull()?.device ?: return
		if (!stampedFor(action.stamp, device)) {
			CapabilityLog.record(row.key, CapabilityLogEvent.IGNORED, accepted = false)
			return
		}
		val gateway = runIsolated { gatewayOf(action.team) }.getOrNull() ?: return
		repo.phoneCapabilityOps.enqueue(gateway, action.team, row)
	}

	private fun onRetract(repo: com.atelier_nyaarium.switchboard.ChatRepository, action: PluginAction) {
		val requestId = runIsolated { action.payload?.get("requestId")?.jsonPrimitive?.content }.getOrNull()
			?: return
		repo.phoneCapabilityOps.retract(requestId)
	}
}
