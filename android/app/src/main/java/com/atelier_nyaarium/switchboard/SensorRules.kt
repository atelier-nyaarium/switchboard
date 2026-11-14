package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.DeviceReading
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSensorPayload
import com.atelier_nyaarium.switchboard.proto.DeviceSensorThreshold
import com.atelier_nyaarium.switchboard.proto.FieldTypes
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

internal data class GatewayGroup(val gatewayId: String, val assistant: Boolean, val list: DeviceListView)

/** Home first; hides empties. */
internal fun deviceGroups(ids: List<String>, home: String?, views: Map<String, DevicesView>): List<GatewayGroup> =
	(listOfNotNull(home?.takeIf { it in ids }) + ids.filter { it != home })
		.map { GatewayGroup(it, it == home, views[it]?.list ?: DeviceListView.Loading) }
		.filter { group ->
			when (val list = group.list) {
				DeviceListView.Declined -> false
				is DeviceListView.Listed -> list.records.isNotEmpty()
				DeviceListView.Loading, is DeviceListView.Unavailable -> true
			}
		}

/** Null shows Celsius. */
internal fun displayUnitOf(assistant: ConsoleAssistantStateResult?): String? =
	assistant?.temperatureUnit?.takeIf { it != "C" }

internal enum class AlertSide(val wire: String, val word: String) {
	LOW("low", "below"),
	HIGH("high", "above"),
}

internal data class AlertRow(
	val measure: String,
	val side: AlertSide,
	val label: String,
	val value: String?,
	val suffix: String,
	val on: Boolean,
)

internal data class AlertBlock(val reading: DeviceReading, val rows: List<AlertRow>, val deadZone: String?)

internal fun thresholdOf(read: ConsoleDeviceReadResult.Sensor, measure: String): DeviceSensorThreshold? =
	read.thresholds.orEmpty().find { it.measure == measure }

private fun sideValue(threshold: DeviceSensorThreshold?, side: AlertSide): Double? =
	if (side == AlertSide.LOW) threshold?.low else threshold?.high

internal fun alertBlocks(read: ConsoleDeviceReadResult.Sensor, display: String?): List<AlertBlock> =
	read.readings.mapNotNull { reading ->
		val spec = reading.spec as? AssistantFieldSpec.Number ?: return@mapNotNull null
		val sides = reading.alerts.orEmpty().mapNotNull { wire -> AlertSide.entries.find { it.wire == wire } }
		if (sides.isEmpty()) return@mapNotNull null
		val held = thresholdOf(read, spec.field)
		val suffix = spec.unit?.let { suffixOf(displayedUnit(it, display)) }.orEmpty()
		val rows = sides.map { side ->
			val value = sideValue(held, side)
			AlertRow(spec.field, side, "${spec.label} ${side.word}", value?.let { bareNumber(spec, it, display) }, suffix, value != null)
		}
		val deadZone = held?.let { deltaText(spec, it.deadZone, display) + suffix }
		AlertBlock(reading, rows, deadZone)
	}

private fun unitRow(unit: String?, display: String?) =
	FieldTypes.UNIT_DISPLAYS.find { it.unit == unit && it.display == display }

/** Scales widths without offsets. */
internal fun deltaText(spec: AssistantFieldSpec.Number, value: Double, display: String?): String =
	formatDecimal(value * (unitRow(spec.unit, display)?.scale ?: 1.0), (spec.decimals ?: 0L).toInt())

internal const val DEFAULT_DEAD_ZONE = 1.0

internal const val TOO_NARROW = "Too close together for the dead zone"

/** The Gateway's band rule. */
private fun tooNarrow(low: Double?, high: Double?, deadZone: Double): Boolean =
	low != null && high != null && deadZone * 2 >= high - low

internal sealed interface ThresholdEdit {
	data class Put(val put: ConsoleOp.SensorThresholdPut) : ThresholdEdit

	data class Issue(val line: String) : ThresholdEdit
}

private fun putOf(id: String, measure: String, held: DeviceSensorThreshold?, low: Double?, high: Double?, deadZone: Double) =
	ConsoleOp.SensorThresholdPut(
		id = id,
		measure = measure,
		low = low,
		high = high,
		deadZone = deadZone,
		coolDownSec = held?.coolDownSec ?: 0L,
		revision = held?.revision ?: 0L,
	)

internal fun sideEdit(id: String, read: ConsoleDeviceReadResult.Sensor, row: AlertRow, text: String, display: String?): ThresholdEdit {
	val spec = read.readings.firstNotNullOfOrNull { (it.spec as? AssistantFieldSpec.Number)?.takeIf { s -> s.field == row.measure } }
		?: return ThresholdEdit.Issue("Not a reading")
	val typed = parseDecimal(text.trim()) ?: return ThresholdEdit.Issue("Not a number")
	val value = if (spec.unit != null && display != null) fromDisplay(typed, spec.unit, display) else typed
	val held = thresholdOf(read, row.measure)
	val low = if (row.side == AlertSide.LOW) value else held?.low
	val high = if (row.side == AlertSide.HIGH) value else held?.high
	if (low != null && high != null && low >= high) return ThresholdEdit.Issue("Below must be under above")
	val deadZone = held?.deadZone ?: DEFAULT_DEAD_ZONE
	if (tooNarrow(low, high, deadZone)) return ThresholdEdit.Issue(TOO_NARROW)
	return ThresholdEdit.Put(putOf(id, row.measure, held, low, high, deadZone))
}

/** Off clears threshold side. */
internal fun sideCleared(id: String, read: ConsoleDeviceReadResult.Sensor, row: AlertRow): ConsoleOp.SensorThresholdPut? {
	val held = thresholdOf(read, row.measure) ?: return null
	val low = if (row.side == AlertSide.LOW) null else held.low
	val high = if (row.side == AlertSide.HIGH) null else held.high
	return putOf(id, row.measure, held, low, high, held.deadZone)
}

internal fun deadZoneEdit(id: String, read: ConsoleDeviceReadResult.Sensor, measure: String, text: String, display: String?): ThresholdEdit {
	val spec = read.readings.firstNotNullOfOrNull { (it.spec as? AssistantFieldSpec.Number)?.takeIf { s -> s.field == measure } }
		?: return ThresholdEdit.Issue("Not a reading")
	val held = thresholdOf(read, measure) ?: return ThresholdEdit.Issue("Set an alert first")
	val typed = parseDecimal(text.trim()) ?: return ThresholdEdit.Issue("Not a number")
	if (typed < 0) return ThresholdEdit.Issue("Must not be negative")
	val width = roundTo(typed / (unitRow(spec.unit, display)?.scale ?: 1.0), FieldTypes.CONVERTED_DECIMALS)
	if (tooNarrow(held.low, held.high, width)) return ThresholdEdit.Issue(TOO_NARROW)
	return ThresholdEdit.Put(putOf(id, measure, held, held.low, held.high, width))
}

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
