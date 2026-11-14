package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceNearby
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Capture time when known. */
internal data class Sighting(val mac: String, val signal: Int, val advert: Advert, val at: Long? = null)

/** BlueZ's per-device union. */
internal fun unionAdvert(held: Advert, fresh: Advert): Advert = Advert(
	name = fresh.name ?: held.name,
	data = held.data + fresh.data,
	services = (held.services + fresh.services).distinct(),
)

/** Null Gateway means phone. */
internal data class Hearer(val gatewayId: String?, val signal: Int)

internal data class DefinitionHit(val key: String, val model: String?)

internal data class FoundDevice(
	val mac: String,
	val advert: Advert,
	val definition: DefinitionHit?,
	val hearers: List<Hearer>,
	val supported: Boolean = true,
) {
	val strongest: Int get() = hearers.maxOf { it.signal }
}

internal fun sightingOf(nearby: DeviceNearby): Sighting = Sighting(
	mac = nearby.mac,
	signal = nearby.signal.toInt(),
	advert = Advert(
		name = nearby.name,
		data = nearby.data.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.content?.let { key to it } }.toMap(),
		services = nearby.services.orEmpty(),
	),
)

/** Null radio means phone. */
internal data class Heard(
	val order: List<String> = emptyList(),
	val radios: Map<String?, Map<String, Sighting>> = emptyMap(),
)

/** Per-radio packet unions. */
internal fun Heard.with(radio: String?, sightings: List<Sighting>): Heard {
	if (sightings.isEmpty()) return this
	val held = radios[radio].orEmpty().toMutableMap()
	val known = order.toHashSet()
	val order = order.toMutableList()
	for (sighting in sightings) {
		val prior = held[sighting.mac]
		held[sighting.mac] = prior?.let { sighting.copy(advert = unionAdvert(it.advert, sighting.advert)) } ?: sighting
		if (known.add(sighting.mac)) order += sighting.mac
	}
	return Heard(order, radios + (radio to held))
}

/** Rows retain first-heard order. */
internal fun foundDevices(
	family: String,
	heard: Heard,
	paired: Set<String>,
	definitionOf: (Advert) -> DefinitionHit?,
): List<FoundDevice> = heard.order.filter { it !in paired }.mapNotNull { mac ->
	val rows = heard.radios.mapNotNull { (radio, held) ->
		held[mac]?.takeIf { familyOf(it.advert) == family }?.let { Hearer(radio, it.signal) to it.advert }
	}
	if (rows.isEmpty()) return@mapNotNull null
	val advert = rows.map { it.second }.reduce(::unionAdvert)
	FoundDevice(mac, advert, definitionOf(advert), rows.map { it.first }, supported = !unsupported(advert))
}

internal fun testedLine(found: FoundDevice): String? =
	if (found.definition == null && found.supported) "Not tested · raw only" else null

internal fun foundModel(found: FoundDevice): String? = found.definition?.model

internal data class PairChoice(val gatewayId: String?, val label: String, val assistant: Boolean, val signal: Int)

/** Skips known-offline Gateways. */
internal fun scanTargets(roster: GatewayRegistry): List<String> = roster.ids().filter { roster.connected(it) != false }

/** Home first, phone last. */
internal fun pairChoices(found: FoundDevice, home: String?): List<PairChoice> {
	val gateways = found.hearers.mapNotNull { hearer -> hearer.gatewayId?.let { it to hearer.signal } }
		.distinctBy { it.first }
		.sortedWith(compareBy({ it.first != home }, { it.first }))
		.map { (gatewayId, signal) -> PairChoice(gatewayId, gatewayId, assistant = gatewayId == home, signal) }
	val phone = found.hearers.filter { it.gatewayId == null }.maxByOrNull { it.signal }
		?.takeIf { home != null }
		?.let { PairChoice(null, THIS_PHONE, assistant = true, it.signal) }
	return gateways + listOfNotNull(phone)
}

/** Phone records use home. */
internal fun pairingOf(found: FoundDevice, choice: PairChoice, home: String): Pair<String, SensorPairing> =
	if (choice.gatewayId == null) {
		home to SensorPairing(found.mac, Protocol.Wire.DeviceRadio.PHONES, found.definition?.key, advertOf(found.advert))
	} else {
		choice.gatewayId to SensorPairing(found.mac, Protocol.Wire.DeviceRadio.GATEWAY, found.definition?.key, null)
	}

/** Match chosen Gateway listing. */
internal fun landedOn(paired: List<Pair<String, DeviceRecord>>, mac: String, gatewayId: String): Boolean =
	paired.any { (on, record) -> on == gatewayId && record.id == mac }

internal fun advertOf(advert: Advert): DeviceAdvert = DeviceAdvert(
	name = advert.name,
	data = JsonObject(advert.data.mapValues { JsonPrimitive(it.value) }),
	services = advert.services,
)

internal fun signalBars(signal: Int): Int = when {
	signal >= -60 -> 4
	signal >= -70 -> 3
	signal >= -80 -> 2
	else -> 1
}
