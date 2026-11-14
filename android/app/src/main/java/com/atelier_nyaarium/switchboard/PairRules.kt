package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceNearby
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Capture time when known. */
internal data class Sighting(val mac: String, val signal: Int, val advert: Advert, val at: Long? = null)

/** Null Gateway means phone. */
internal data class Hearer(val gatewayId: String?, val signal: Int)

internal data class DefinitionHit(val key: String, val model: String?)

internal data class FoundDevice(
	val mac: String,
	val advert: Advert,
	val definition: DefinitionHit?,
	val hearers: List<Hearer>,
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

/** Strongest sighting per address. */
internal fun foundDevices(
	family: String,
	gateways: Map<String, List<Sighting>>,
	phone: List<Sighting>,
	paired: Set<String>,
	definitionOf: (Advert) -> DefinitionHit?,
): List<FoundDevice> {
	val heard = gateways.flatMap { (gatewayId, sightings) -> sightings.map { Hearer(gatewayId, it.signal) to it } } +
		phone.map { Hearer(null, it.signal) to it }
	return heard
		.filter { (_, sighting) -> sighting.mac !in paired && familyOf(sighting.advert) == family }
		.groupBy { (_, sighting) -> sighting.mac }
		.map { (mac, rows) ->
			val loudest = rows.maxBy { (_, sighting) -> sighting.signal }.second
			FoundDevice(mac, loudest.advert, definitionOf(loudest.advert), rows.map { it.first })
		}
		.sortedByDescending { it.strongest }
}

internal fun testedLine(found: FoundDevice): String? = if (found.definition == null) "Not tested · raw only" else null

internal fun foundModel(found: FoundDevice): String? = found.definition?.model

internal data class PairChoice(val gatewayId: String?, val label: String, val assistant: Boolean)

/** Gateways first; phone last. */
internal fun pairChoices(found: FoundDevice, home: String?): List<PairChoice> {
	val gateways = found.hearers.filter { it.gatewayId != null }.sortedByDescending { it.signal }
		.distinctBy { it.gatewayId }
		.mapNotNull { hearer -> hearer.gatewayId?.let { PairChoice(it, it, assistant = it == home) } }
	val phone = found.hearers.firstOrNull { it.gatewayId == null }
		?.takeIf { home != null }
		?.let { PairChoice(null, THIS_PHONE, assistant = true) }
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
