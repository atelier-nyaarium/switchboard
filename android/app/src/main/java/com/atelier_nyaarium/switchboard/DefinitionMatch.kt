package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceDefinitionMatch
import com.atelier_nyaarium.switchboard.proto.SHIPPED_DEVICE_DEFINITION_MATCHES

// Fixture-pinned TS twin.

/** Present names must match. */
internal fun definitionMatches(definition: DeviceDefinitionMatch, advert: Advert): Boolean {
	val prefix = definition.namePrefix
	val name = advert.name
	if (prefix != null && name != null && !name.startsWith(prefix)) return false
	return definition.sources.any { source ->
		val data = advert.data[source.company.toString()] ?: return@any false
		data.startsWith(source.prefix) && data.length / 2 >= source.minLength
	}
}

/** Pairing needs the name. */
internal fun definitionIdentifies(definition: DeviceDefinitionMatch, advert: Advert): Boolean {
	val prefix = definition.namePrefix ?: return definitionMatches(definition, advert)
	return advert.name?.startsWith(prefix) == true && definitionMatches(definition, advert)
}

/** One identifying definition. */
internal fun definitionHit(family: String, advert: Advert): DefinitionHit? =
	SHIPPED_DEVICE_DEFINITION_MATCHES.filter { it.family == family && definitionIdentifies(it, advert) }
		.singleOrNull()
		?.let { DefinitionHit(it.key, it.models.firstOrNull()) }
