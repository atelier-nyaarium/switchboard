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

/** A network the plug sees. */
internal data class HomeNetwork(val ssid: String, val keyType: Int)

/** A phone scan result. */
internal data class HeardNetwork(val ssid: String, val frequencyMhz: Int, val rssi: Int, val ageMs: Long)

private const val FRESH_SCAN_MS = 120_000L

/** Fresh 2.4 GHz signal per listed network; null when none heard. */
internal fun phoneSignals(homes: List<HomeNetwork>, heard: List<HeardNetwork>?): Map<String, Int>? {
	val listed = homes.mapTo(HashSet()) { it.ssid }
	return heard.orEmpty()
		.filter { it.ssid in listed && it.frequencyMhz in 2400..2500 && it.ageMs <= FRESH_SCAN_MS }
		.groupBy { it.ssid }
		.mapValues { (_, same) -> same.maxOf { it.rssi } }
		.takeIf { it.isNotEmpty() }
}

/** Strongest first, else the plug's order. */
internal fun strongestFirst(homes: List<HomeNetwork>, signals: Map<String, Int>?): List<HomeNetwork> =
	if (signals == null) homes else homes.sortedByDescending { signals[it.ssid] ?: Int.MIN_VALUE }

/** Bars null draws a radio. */
internal data class HomeRow(val home: HomeNetwork, val picked: Boolean, val bars: Int?)

internal fun homeRows(run: SetupRun): List<HomeRow> = run.homes.map { home ->
	HomeRow(home, picked = run.home == home, bars = barsOf(run, home))
}

private fun barsOf(run: SetupRun, home: HomeNetwork): Int? = run.signals?.let { signalBars(it[home.ssid]) ?: 0 }

/** The WiFi line above the list. */
internal sealed interface WifiLine {
	data class Picked(val ssid: String, val bars: Int?) : WifiLine

	/** Your WiFi, out of the plug's reach. */
	data class Unseen(val ssid: String) : WifiLine

	data object Blank : WifiLine
}

/** An open list shows the pick itself. */
internal fun wifiLine(run: SetupRun, open: Boolean): WifiLine {
	val home = run.home
	val yours = run.yours
	return when {
		home != null -> if (open) WifiLine.Blank else WifiLine.Picked(home.ssid, barsOf(run, home))
		yours != null -> WifiLine.Unseen(yours)
		else -> WifiLine.Blank
	}
}

/** Open until a network is picked. */
internal fun wifiListOpen(run: SetupRun, changing: Boolean): Boolean = changing || run.home == null

internal enum class PasswordSource { TYPED, VAULT }

internal fun defaultSource(memory: SetupMemory): PasswordSource =
	if (memory.wifiEntry != null) PasswordSource.VAULT else PasswordSource.TYPED

/** Set up waits for every value. */
internal fun setupReady(run: SetupRun, name: String, source: PasswordSource, typed: String, entry: String?): Boolean =
	run.home != null && nameReady(name) && when (source) {
		PasswordSource.TYPED -> typed.isNotEmpty()
		PasswordSource.VAULT -> entry != null
	}

/** Out of three; null when unknown. */
internal fun signalBars(rssi: Int?): Int? = when {
	rssi == null -> null
	rssi >= -60 -> 3
	rssi >= -72 -> 2
	else -> 1
}

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
	/** Your WiFi, when known. */
	val yours: String? = null,
	/** From `phoneSignals`. */
	val signals: Map<String, Int>? = null,
)

/** The Gateway's own network, else the one the last setup used. */
internal fun yourWifi(gateway: String?, memory: SetupMemory): String? = gateway ?: memory.ssid

/** Your WiFi when the plug sees it; with none known, the owner picks. */
internal fun preferredHome(homes: List<HomeNetwork>, yours: String?): HomeNetwork? = homes.find { it.ssid == yours }

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

/** Named networks, once each. */
internal fun homeNetworksOf(json: String): List<HomeNetwork> = runIsolated {
	val list = moduleAnswer(json, "netif", "get_scaninfo")?.get("ap_list")?.jsonArray ?: return@runIsolated emptyList()
	list.mapNotNull { element ->
		val ap = element.jsonObject
		val ssid = ap["ssid"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
		HomeNetwork(ssid, ap["key_type"]?.jsonPrimitive?.int ?: 0)
	}.distinctBy { it.ssid }
}.getOrNull() ?: emptyList()

/** The vault's value, or null to ask the owner. */
internal suspend fun setupPassword(entry: String?, reveal: suspend (String) -> String?): String? =
	entry?.let { reveal(it) }?.takeIf { it.isNotEmpty() }

/** The paired name, else the plug's own unless it is its setup network's, else blank for the owner. */
internal fun setupName(plug: PlugFacts, paired: String?, networkPrefix: String): String =
	paired ?: plug.alias.takeUnless { it.isBlank() || it.startsWith(networkPrefix) }.orEmpty()
