package com.atelier_nyaarium.switchboard.liveconsole

import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEvalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleIssue
import com.atelier_nyaarium.switchboard.proto.ConsoleResultItem
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

data class SensorLine(val label: String, val shown: String, val range: String?)

data class ConsoleRow(val title: String, val tag: String?, val trailing: String?, val detail: String?)

data class FieldLine(val depth: Int, val key: String, val text: String?)

sealed interface ConsoleCard {
	data class Failed(val issue: ConsoleIssue) : ConsoleCard

	data class Schema(val entity: ConsoleEntityDescription) : ConsoleCard

	data class Sensor(val name: String, val line: String, val readings: List<SensorLine>) : ConsoleCard

	data class Rows(val heading: String, val rows: List<ConsoleRow>, val more: Long) : ConsoleCard

	data class Fields(val lines: List<FieldLine>) : ConsoleCard

	data class Scalar(val text: String) : ConsoleCard
}

private val INSTANT_KEYS = Protocol.Wire.CONSOLE_INSTANT_KEYS
private val TITLE_KEYS = listOf("name", "label", "id", "automation", "mac", "key")
private val TAG_KEYS = listOf("outcome", "kind", "action", "radio")
private const val INSTANT_FLOOR = Protocol.Wire.CONSOLE_INSTANT_FLOOR
private const val INSTANT_CEILING = Protocol.Wire.CONSOLE_INSTANT_CEILING
private const val FIELD_DEPTH_MAX = 3

internal fun ageOf(at: Long, now: Long): String {
	val seconds = (now - at) / 1000
	val span = kotlin.math.abs(seconds)
	val text =
		when {
			span < 45 -> "$span s"
			span < 2_700 -> "${(span + 30) / 60} min"
			span < 129_600 -> "${(span + 1_800) / 3_600} h"
			else -> "${(span + 43_200) / 86_400} days"
		}
	return if (now >= at) "$text ago" else "in $text"
}

/** Display strings stay on one line. */
internal fun oneLine(text: String): String {
	val out = StringBuilder()
	var gap = false
	for (c in text) {
		// ASCII whitespace only.
		if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
			gap = out.isNotEmpty()
		} else {
			if (gap) out.append(' ')
			gap = false
			out.append(c)
		}
	}
	return out.toString()
}

private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.let(::oneLine)

/** Numeric timestamps after 2001. */
private fun JsonObject.instant(key: String): Long? =
	(this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it in (INSTANT_FLOOR + 1)..INSTANT_CEILING }

internal fun scalarText(value: JsonElement?, key: String?, now: Long): String {
	val primitive = value as? JsonPrimitive ?: return "none"
	if (primitive is JsonNull) return "none"
	if (primitive.isString) return oneLine(primitive.content)
	primitive.booleanOrNull?.let { return if (it) "yes" else "no" }
	val whole = primitive.longOrNull
	if (whole != null && key in INSTANT_KEYS && whole in (INSTANT_FLOOR + 1)..INSTANT_CEILING) return ageOf(whole, now)
	return whole?.toString() ?: primitive.doubleOrNull?.toString() ?: primitive.content
}

private fun sensorCard(value: JsonObject, now: Long): ConsoleCard {
	val readings = (value["readings"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
	val heard = value.instant("heardAt")?.let { ageOf(it, now) }
	val stale = value["stale"].text()
	val line =
		listOfNotNull(value["model"].text(), value["radio"].text()?.let { "$it radio" }, stale ?: heard).joinToString(" · ")
	return ConsoleCard.Sensor(
		name = value["name"].text().orEmpty(),
		line = line,
		readings =
			readings.map { reading ->
				val low = (reading["low"] as? JsonObject)
				val high = (reading["high"] as? JsonObject)
				val range =
					if (low == null && high == null) {
						null
					} else {
						listOfNotNull(
							low?.let { "low ${it["shown"].text()}" },
							high?.let { "high ${it["shown"].text()}" },
						).joinToString(" · ", prefix = "24 h: ")
					}
				SensorLine(reading["label"].text().orEmpty(), reading["shown"].text() ?: "none", range)
			},
	)
}

private fun rowOf(item: JsonElement, now: Long): ConsoleRow {
	if (item is JsonArray) return ConsoleRow(summaryOf(item), null, null, null)
	val record = item as? JsonObject ?: return ConsoleRow(scalarText(item, null, now), null, null, null)
	val titleKey = TITLE_KEYS.firstOrNull { record[it].text() != null }
	val tagKey = TAG_KEYS.firstOrNull { it != titleKey && record[it].text() != null }
	val instantKey = INSTANT_KEYS.firstOrNull { record.instant(it) != null }
	val detail =
		record.entries
			.filter { (key, value) -> key != titleKey && key != tagKey && key != instantKey && value is JsonPrimitive && value !is JsonNull }
			.take(3)
			.joinToString(" · ") { (key, value) -> "${oneLine(key)} ${scalarText(value, key, now)}" }
	return ConsoleRow(
		title = titleKey?.let { record[it].text() } ?: "{${record.size} fields}",
		tag = tagKey?.let { record[it].text() },
		trailing = instantKey?.let { record.instant(it) }?.let { ageOf(it, now) },
		detail = detail.ifEmpty { null },
	)
}

private fun fieldLines(value: JsonElement, depth: Int, now: Long): List<FieldLine> =
	when (value) {
		is JsonObject ->
			value.entries.flatMap { (raw, field) ->
				val key = oneLine(raw)
				when {
					field is JsonPrimitive -> listOf(FieldLine(depth, key, scalarText(field, key, now)))
					depth + 1 >= FIELD_DEPTH_MAX -> listOf(FieldLine(depth, key, summaryOf(field)))
					else -> listOf(FieldLine(depth, key, null)) + fieldLines(field, depth + 1, now)
				}
			}
		is JsonArray ->
			value.flatMapIndexed { at, item ->
				when {
					item is JsonPrimitive -> listOf(FieldLine(depth, "$at", scalarText(item, null, now)))
					depth + 1 >= FIELD_DEPTH_MAX -> listOf(FieldLine(depth, "$at", summaryOf(item)))
					else -> listOf(FieldLine(depth, "$at", null)) + fieldLines(item, depth + 1, now)
				}
			}
		else -> listOf(FieldLine(depth, "", scalarText(value, null, now)))
	}

private fun summaryOf(value: JsonElement): String =
	when (value) {
		is JsonArray -> "${value.size} items"
		is JsonObject -> "${value.size} fields"
		else -> value.toString()
	}

data class ConsoleDrawn(val card: ConsoleCard, val saved: String?)

private fun cardOf(item: ConsoleResultItem, description: ConsoleDescription?, now: Long): ConsoleCard {
	val entity = item.entity?.let { name -> description?.entities?.firstOrNull { it.name == name } }
	val value = item.value
	return when {
		entity != null -> ConsoleCard.Schema(entity)
		item.type == "Sensor" && value is JsonObject && value["readings"] is JsonArray -> sensorCard(value, now)
		value is JsonArray -> {
			val total = item.cut?.total ?: value.size.toLong()
			val noun = if (total == 1L) "item" else "items"
			ConsoleCard.Rows(
				heading = listOfNotNull(item.type, "$total $noun").joinToString(" · "),
				rows = value.map { rowOf(it, now) },
				more = total - value.size,
			)
		}
		value is JsonObject -> ConsoleCard.Fields(fieldLines(value, 0, now))
		else -> ConsoleCard.Scalar(scalarText(value, null, now))
	}
}

/** Keep statement results separate. */
fun cardsOf(result: ConsoleEvalResult, description: ConsoleDescription?, now: Long): List<ConsoleDrawn> =
	when (result) {
		is ConsoleEvalResult.Error -> listOf(ConsoleDrawn(ConsoleCard.Failed(result.issue), null))
		is ConsoleEvalResult.Ok -> result.results.map { ConsoleDrawn(cardOf(it, description, now), it.assigned) }
	}
