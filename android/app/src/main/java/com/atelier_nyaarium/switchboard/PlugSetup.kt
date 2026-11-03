package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** A network the plug can see, for it to join. */
internal data class HomeNetwork(val ssid: String, val keyType: Int, val signal: Int)

internal data class PlugFacts(val mac: String, val model: String, val alias: String)

/** What the phone keeps between setups; no secret. */
internal data class SetupMemory(val ssid: String? = null, val wifiEntry: String? = null)

internal enum class SetupStage { JOINING, READY, HANDING, WAITING, ASK_PASSWORD, DONE, FAILED }

internal data class SetupRun(
	val gatewayId: String,
	/** The picker matches setup networks by it. */
	val networkPrefix: String,
	val stage: SetupStage,
	val plug: PlugFacts? = null,
	val homes: List<HomeNetwork> = emptyList(),
	val home: HomeNetwork? = null,
	val name: String? = null,
	val said: String? = null,
	/** The device id once it is on the network. */
	val deviceId: String? = null,
)

/** Your WiFi is the one the last setup used; with none yet, the owner picks. */
internal fun preferredHome(homes: List<HomeNetwork>, memory: SetupMemory): HomeNetwork? =
	homes.find { it.ssid == memory.ssid }

internal sealed interface WifiSight {
	/** No setup has named your WiFi yet. */
	data object Unknown : WifiSight

	data class Seen(val home: HomeNetwork) : WifiSight

	data class NotSeen(val ssid: String) : WifiSight
}

internal fun wifiSight(homes: List<HomeNetwork>, memory: SetupMemory): WifiSight {
	val ssid = memory.ssid ?: return WifiSight.Unknown
	return homes.find { it.ssid == ssid }?.let { WifiSight.Seen(it) } ?: WifiSight.NotSeen(ssid)
}

internal fun canonicalMac(value: String): String = value.trim().lowercase().replace('-', ':')

internal object KasaSetupCommands {
	const val SYSINFO = """{"system":{"get_sysinfo":{}}}"""
	const val SCAN = """{"netif":{"get_scaninfo":{"refresh":1}}}"""

	fun alias(name: String): String = buildJsonObject {
		putJsonObject("system") { putJsonObject("set_dev_alias") { put("alias", name) } }
	}.toString()

	fun join(home: HomeNetwork, password: String): String = buildJsonObject {
		putJsonObject("netif") {
			putJsonObject("set_stainfo") {
				put("ssid", home.ssid)
				put("password", password)
				put("key_type", home.keyType)
			}
		}
	}.toString()
}

private fun moduleAnswer(json: String, module: String, method: String): JsonObject? {
	val answer = Json.parseToJsonElement(json).jsonObject[module]?.jsonObject?.get(method)?.jsonObject ?: return null
	return answer.takeIf { (it["err_code"]?.jsonPrimitive?.intOrNull ?: 0) == 0 }
}

/** Null when the answer is not a plug's sysinfo. */
internal fun plugFactsOf(json: String): PlugFacts? = runIsolated {
	val info = moduleAnswer(json, "system", "get_sysinfo") ?: return@runIsolated null
	val mac = info["mac"]?.jsonPrimitive?.content ?: info["mic_mac"]?.jsonPrimitive?.content ?: return@runIsolated null
	PlugFacts(
		mac = canonicalMac(mac),
		model = info["model"]?.jsonPrimitive?.content.orEmpty(),
		alias = info["alias"]?.jsonPrimitive?.content.orEmpty(),
	)
}.getOrNull()

/** Networks the plug sees, hidden ones dropped, strongest first. */
internal fun homeNetworksOf(json: String): List<HomeNetwork> = runIsolated {
	val list = moduleAnswer(json, "netif", "get_scaninfo")?.get("ap_list")?.jsonArray ?: return@runIsolated emptyList()
	list.mapNotNull { element ->
		val ap = element.jsonObject
		val ssid = ap["ssid"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
		HomeNetwork(ssid, ap["key_type"]?.jsonPrimitive?.int ?: 0, ap["rssi"]?.jsonPrimitive?.intOrNull ?: -100)
	}.groupBy { it.ssid }.map { (_, same) -> same.maxBy { it.signal } }.sortedByDescending { it.signal }
}.getOrNull() ?: emptyList()

/** The vault's value, or null to ask the owner. */
internal suspend fun setupPassword(entry: String?, reveal: suspend (String) -> String?): String? =
	entry?.let { reveal(it) }?.takeIf { it.isNotEmpty() }

/** A setup name falls back to the model. */
internal fun setupName(plug: PlugFacts): String = plug.alias.ifBlank { plug.model }
