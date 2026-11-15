package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.DeviceReading
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSensorPayload
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

internal const val THIS_PHONE = "This Phone"

internal fun DeviceRecord.isSensor(): Boolean = kind == Protocol.Wire.DeviceKind.SENSOR

internal fun DeviceRecord.onPhones(): Boolean = radio == Protocol.Wire.DeviceRadio.PHONES

internal fun DevicesView.sensorOf(id: String): SensorHeld? = devices[id]?.sensor

internal fun valueOf(element: JsonElement?): Any? {
	val primitive = element as? JsonPrimitive ?: return null
	if (primitive is JsonNull) return null
	if (primitive.isString) return primitive.content
	return primitive.booleanOrNull ?: primitive.doubleOrNull
}

internal fun readingText(reading: DeviceReading, display: String?): String? =
	valueOf(reading.value)?.let { formatFieldValue(reading.spec, it, display) }

internal data class MainValue(val text: String, val stale: Boolean)

internal fun mainValue(held: SensorHeld?, display: String?): MainValue? {
	val read = held?.read ?: return null
	val text = read.readings.firstNotNullOfOrNull { readingText(it, display) } ?: return null
	return MainValue(text, read.stale != null || held.failed != null)
}

internal fun sensorTrouble(held: SensorHeld?, now: Long): String? {
	held?.failed?.let { return it }
	val read = held?.read ?: return null
	if (read.stale == null) return null
	return read.heardAt?.let { "Last heard ${agoText(it, now)}" } ?: "Not heard yet"
}

internal fun sensorSubtitle(record: DeviceRecord, model: String?, gatewayId: String, held: SensorHeld?, now: Long): String {
	val brand = listOfNotNull(brandLine(record), model).joinToString(" ")
	val heard = held?.read?.takeIf { it.stale == null && held.failed == null }?.heardAt?.let { agoText(it, now) }
	return listOfNotNull(brand, gatewayId, THIS_PHONE.takeIf { record.onPhones() }, heard).joinToString(" · ")
}

internal fun extremesLine(reading: DeviceReading, display: String?, at: (Long) -> String): String? {
	val spec = reading.spec as? AssistantFieldSpec.Number ?: return null
	val low = reading.low?.let { "low ${bareNumber(spec, it.value, display)} at ${at(it.at)}" }
	val high = reading.high?.let { "high ${bareNumber(spec, it.value, display)} at ${at(it.at)}" }
	return listOfNotNull(low, high).takeIf { it.isNotEmpty() }?.joinToString(" · ", prefix = "24 h: ")
}

/** Converts without suffix. */
internal fun bareNumber(spec: AssistantFieldSpec.Number, value: Double, display: String?): String {
	val shown = if (spec.unit != null && display != null) toDisplay(value, spec.unit, display).value else value
	return formatDecimal(shown, (spec.decimals ?: 0L).toInt())
}

internal fun displayedUnit(unit: String, display: String?): String =
	if (display != null) toDisplay(0.0, unit, display).unit ?: unit else unit

internal fun rowBrandLine(record: DeviceRecord): String =
	if (record.onPhones()) "${brandLine(record)} · $THIS_PHONE" else brandLine(record)

internal data class GatewayGroup(val gatewayId: String, val assistant: Boolean, val records: List<DeviceRecord>)

/** Home first; listed devices only. */
internal fun deviceGroups(ids: List<String>, home: String?, views: Map<String, DevicesView>): List<GatewayGroup> =
	(listOfNotNull(home?.takeIf { it in ids }) + ids.filter { it != home }).mapNotNull { gatewayId ->
		val records = (views[gatewayId]?.list as? DeviceListView.Listed)?.records
		records?.takeIf { it.isNotEmpty() }?.let { GatewayGroup(gatewayId, gatewayId == home, it) }
	}

/** Home services get a group; session Gateway leads. */
internal fun sourceGroups(
	ids: List<String>,
	home: String?,
	views: Map<String, DevicesView>,
	hasServices: Boolean,
	lead: String?,
): List<GatewayGroup> {
	val devices = deviceGroups(ids, home, views)
	val servicesOnly = home != null && hasServices && devices.none { it.assistant }
	val groups = if (servicesOnly) listOf(GatewayGroup(home!!, assistant = true, records = emptyList())) + devices else devices
	return leading(groups, lead) { it.gatewayId }
}

/** What stands where Services go until the home has answered; null draws them. */
internal fun servicesWaiting(read: AssistantRead): String? = when (read) {
	is AssistantRead.Answered -> null
	AssistantRead.Reading -> ""
	AssistantRead.Refused -> "This Gateway did not answer for its services."
}

internal data class HomeHolding(
	val sources: List<AssistantSource> = emptyList(),
	val integrations: List<AssistantIntegration>? = null,
	val display: String? = null,
	/** Null hides the unit row. */
	val temperatureUnit: String? = null,
)

/** Unread: [servicesWaiting] stands in. */
internal fun homeHolding(read: AssistantRead?): HomeHolding = when (read) {
	is AssistantRead.Answered -> HomeHolding(sourcesOf(read.state), read.state.integrations, displayUnitOf(read), read.state.temperatureUnit)
	null, AssistantRead.Reading, AssistantRead.Refused -> HomeHolding()
}

/** No Gateway has answered. */
internal fun devicesPending(ids: List<String>, views: Map<String, DevicesView>): Boolean =
	ids.isNotEmpty() && ids.all { (views[it]?.list ?: DeviceListView.Loading) == DeviceListView.Loading }

/** Unread shows the stored unit. */
internal fun displayUnitOf(read: AssistantRead): String? = when (read) {
	is AssistantRead.Answered -> read.state.temperatureUnit?.takeIf { it != "C" }
	AssistantRead.Reading, AssistantRead.Refused -> null
}

/** No home holds no preference. */
internal fun homeDisplayUnit(registry: GatewayRegistry, home: String?): String? =
	if (home == null) null else displayUnitOf(registry.assistantRead(home))

internal data class PayloadRow(val at: Long, val radio: String, val bytes: List<String>, val changed: List<Boolean>)

internal data class PayloadView(val company: String, val rows: List<PayloadRow>)

/** Marks changed bytes. */
internal fun payloadView(payloads: List<DeviceSensorPayload>, gatewayId: String): PayloadView? {
	val company = payloads.firstNotNullOfOrNull { it.data.keys.firstOrNull() } ?: return null
	val hex = payloads.map { payload -> (payload.data[company] as? JsonPrimitive)?.content.orEmpty().chunked(2) }
	val rows = payloads.mapIndexed { index, payload ->
		val bytes = hex[index]
		val older = hex.getOrNull(index + 1)
		PayloadRow(
			at = payload.at,
			radio = if (payload.radio == Protocol.Wire.DeviceRadio.PHONES) THIS_PHONE else gatewayId,
			bytes = bytes,
			changed = bytes.mapIndexed { at, byte -> older != null && older.getOrNull(at) != byte },
		)
	}
	return PayloadView("0x%04x".format(company.toIntOrNull() ?: 0), rows)
}
