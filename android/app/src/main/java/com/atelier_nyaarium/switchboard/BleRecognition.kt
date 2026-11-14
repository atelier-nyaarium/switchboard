package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.BluetoothMatch
import com.atelier_nyaarium.switchboard.proto.INTEGRATIONS

// Fixture-pinned TS twin.

/** Scan-window union. */
internal data class Advert(
	val name: String? = null,
	/** Decimal company id to data hex, id excluded. */
	val data: Map<String, String> = emptyMap(),
	/** Lower-case hex, 16-bit. */
	val services: List<String> = emptyList(),
)

private fun fits(data: String, pattern: String): Boolean =
	data.length >= pattern.length &&
		pattern.chunked(2).withIndex().all { (i, pair) -> pair == "xx" || data.substring(i * 2, i * 2 + 2) == pair }

internal fun recognizes(match: BluetoothMatch, advert: Advert): Boolean {
	val name = advert.name ?: ""
	if (match.excludeNames.any { name.startsWith(it) }) return false
	if (match.excludeData.any { fits(advert.data[it.company.toString()] ?: "", it.pattern) }) return false
	if (match.services.any { it in advert.services }) return true
	return match.makerData.any { marker ->
		val data = advert.data[marker.company.toString()] ?: return@any false
		data.startsWith(marker.prefix) && (marker.withService == null || marker.withService in advert.services)
	}
}

internal fun familyOf(advert: Advert): String? =
	INTEGRATIONS.firstOrNull { integration -> integration.bluetooth?.let { recognizes(it, advert) } == true }?.id
