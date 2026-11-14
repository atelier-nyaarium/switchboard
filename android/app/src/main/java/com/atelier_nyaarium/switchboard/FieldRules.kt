package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import kotlin.math.abs
import kotlin.math.pow

// Fixture-pinned TS twin.

/** No exponent or hex. */
private val DECIMAL = Regex("^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$")

internal fun parseDecimal(text: String): Double? {
	if (!DECIMAL.matches(text)) return null
	val value = text.toDoubleOrNull() ?: return null
	if (!value.isFinite()) return null
	return if (value == 0.0) 0.0 else value
}

/** Scaling preserves integer safety. */
internal fun inRange(value: Double, decimals: Int): Boolean =
	value.isFinite() && abs(value) * 10.0.pow(decimals) <= MAX_SAFE_INTEGER

private const val MAX_SAFE_INTEGER = 9007199254740991.0

/** Matches JS Math.round. */
internal fun roundTo(value: Double, decimals: Int): Double {
	val scale = 10.0.pow(decimals)
	val rounded = Math.round(value * scale) / scale
	return if (rounded == 0.0) 0.0 else rounded
}

/** Integer-based fixed decimals. */
internal fun formatDecimal(value: Double, decimals: Int): String {
	val scaled = Math.round(value * 10.0.pow(decimals))
	val digits = abs(scaled).toString().padStart(decimals + 1, '0')
	val whole = digits.substring(0, digits.length - decimals)
	val fraction = if (decimals > 0) "." + digits.substring(digits.length - decimals) else ""
	return (if (scaled < 0) "-" else "") + whole + fraction
}

internal data class Shown(val value: Double, val unit: String?)

/** Unscaled values keep units. */
internal fun toDisplay(value: Double, unit: String, display: String): Shown {
	val row = FieldTypes.UNIT_DISPLAYS.find { it.unit == unit && it.display == display } ?: return Shown(value, unit)
	return Shown(value * row.scale + row.offset, display)
}

internal fun fromDisplay(value: Double, unit: String, display: String): Double {
	val row = FieldTypes.UNIT_DISPLAYS.find { it.unit == unit && it.display == display } ?: return value
	return roundTo((value - row.offset) / row.scale, FieldTypes.CONVERTED_DECIMALS)
}

internal fun suffixOf(unit: String): String = FieldTypes.UNIT_SUFFIXES[unit] ?: " $unit"

/** Hex rows include offsets. */
internal fun bytesText(hex: String): String =
	hex.chunked(2).chunked(FieldTypes.BYTES_PER_ROW).mapIndexed { row, bytes ->
		"${row * FieldTypes.BYTES_PER_ROW}: ${bytes.joinToString(" ")}"
	}.joinToString(" | ")

/** Uses owner-selected units. */
internal fun formatFieldValue(spec: AssistantFieldSpec, value: Any, display: String? = null): String =
	when (spec) {
		is AssistantFieldSpec.Number -> {
			val number = (value as? Number)?.toDouble()
			if (number == null) value.toString()
			else {
				val shown = if (spec.unit != null && display != null) toDisplay(number, spec.unit, display) else Shown(number, spec.unit)
				val text = formatDecimal(shown.value, (spec.decimals ?: 0L).toInt())
				if (shown.unit != null) text + suffixOf(shown.unit) else text
			}
		}
		is AssistantFieldSpec.Bytes -> bytesText(value.toString())
		is AssistantFieldSpec.Enumeration -> spec.options.find { it.value == value }?.label ?: value.toString()
		is AssistantFieldSpec.Text, is AssistantFieldSpec.Unknown -> value.toString()
	}
