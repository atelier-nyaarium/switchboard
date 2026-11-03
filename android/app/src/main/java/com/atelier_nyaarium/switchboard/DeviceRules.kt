package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceScheduleRule
import com.atelier_nyaarium.switchboard.proto.KasaClock
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlin.math.abs
import kotlin.math.roundToLong

internal val DAY_INITIALS = listOf("S", "M", "T", "W", "T", "F", "S")
private val DAY_NAMES = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

internal data class ScheduleDraft(val enabled: Boolean, val rules: List<DeviceScheduleRule>) {
	fun toSchedule() = DeviceSchedule(enabled = enabled, rules = rules)

	val full: Boolean get() = rules.size >= Protocol.DEVICE_MAX_RULES

	fun added(): ScheduleDraft =
		if (full) this else copy(rules = rules + DeviceScheduleRule(days = List(7) { true }, time = "18:00", action = "on", enabled = true))

	fun removed(index: Int): ScheduleDraft = copy(rules = rules.filterIndexed { at, _ -> at != index })

	fun edited(index: Int, change: (DeviceScheduleRule) -> DeviceScheduleRule): ScheduleDraft =
		copy(rules = rules.mapIndexed { at, rule -> if (at == index) change(rule) else rule })

	fun dayToggled(index: Int, day: Int): ScheduleDraft =
		edited(index) { rule -> rule.copy(days = rule.days.mapIndexed { at, on -> if (at == day) !on else on }) }

	fun withAction(index: Int, action: String): ScheduleDraft = edited(index) { it.copy(action = action) }

	val savable: Boolean get() = rules.all { rule -> rule.days.any { it } }
}

internal fun scheduleDraftOf(schedule: DeviceSchedule) = ScheduleDraft(schedule.enabled, schedule.rules)

internal fun daysText(days: List<Boolean>): String {
	val on = days.indices.filter { days[it] }
	return when (on) {
		(0..6).toList() -> "Every day"
		(1..5).toList() -> "Weekdays"
		listOf(0, 6) -> "Weekends"
		emptyList<Int>() -> "No days"
		else -> on.joinToString(" ") { DAY_NAMES[it] }
	}
}

/** Null while reading; the spinner says it. */
internal fun liveLine(live: DeviceLive?): String? {
	val state = when (live?.state ?: return null) {
		Protocol.Wire.DeviceState.ON -> "On"
		Protocol.Wire.DeviceState.OFF -> "Off"
		Protocol.Wire.DeviceState.UNREACHABLE -> "Not answering"
		else -> "Unknown"
	}
	return if (live.stale) "$state · last known" else state
}

internal fun clockLine(clock: KasaClock, readAt: Long): String {
	val plugAt = try {
		OffsetDateTime.parse(clock.time).toInstant().toEpochMilli()
	} catch (_: DateTimeParseException) {
		return "Clock: ${clock.time} (${clock.zone})"
	}
	val minutes = ((plugAt - readAt) / 60_000.0).roundToLong()
	val drift = when {
		minutes == 0L -> "in sync"
		abs(minutes) < 120 -> "${abs(minutes)} min ${if (minutes > 0) "ahead" else "behind"}"
		else -> "${abs(minutes) / 60} h ${if (minutes > 0) "ahead" else "behind"}"
	}
	return "Clock: $drift (${clock.zone})"
}

internal fun nameReady(name: String): Boolean = name.trim().let { it.isNotEmpty() && it.length <= 64 }

internal fun renameReady(name: String, record: DeviceRecord): Boolean = nameReady(name) && name.trim() != record.name

internal fun DeviceListView.retryable(): Boolean = this is DeviceListView.Unavailable

internal fun deviceRecord(view: DevicesView, id: String): DeviceRecord? =
	(view.list as? DeviceListView.Listed)?.records?.find { it.id == id }

internal fun DevicesView.liveOf(id: String): DeviceLive? = plugs[id]?.live

internal fun DevicesView.detailOf(id: String): DeviceDetail? {
	val plug = plugs[id] ?: return null
	val schedule = plug.schedule.held ?: return null
	return DeviceDetail(schedule, plug.settings.held, plug.settings.readAt)
}

internal fun DevicesView.busy(id: String): Boolean = work[id]?.busy == true

internal fun DevicesView.saidOf(id: String): String? = work[id]?.said

internal fun DevicesView.editOf(id: String): ScheduleEdit? = plugs[id]?.schedule?.edit

internal fun DeviceLive?.switchOn(): Boolean = knownOn() == true

internal fun DeviceLive?.knownOn(): Boolean? = this?.pending ?: when (this?.state) {
	Protocol.Wire.DeviceState.ON -> true
	Protocol.Wire.DeviceState.OFF -> false
	else -> null
}

internal sealed interface PowerSlot {
	data class Switch(val on: Boolean) : PowerSlot

	data object Reading : PowerSlot

	/** The state is unknown. */
	data object Hidden : PowerSlot
}

internal fun powerSlot(live: DeviceLive?): PowerSlot =
	live.knownOn()?.let(PowerSlot::Switch) ?: if (live == null) PowerSlot.Reading else PowerSlot.Hidden

internal fun DevicesView.alert(id: String): String? =
	saidOf(id) ?: liveOf(id)?.failed ?: plugs[id]?.schedule?.failed?.takeIf { detailOf(id) == null }

internal fun DevicesView.detailRetry(id: String): Boolean = detailOf(id) == null && plugs[id]?.schedule?.failed != null

internal fun DevicesView.scheduleBase(id: String): DeviceSchedule? = editOf(id)?.base ?: plugs[id]?.schedule?.held

internal fun DevicesView.scheduleDraft(id: String): ScheduleDraft? =
	editOf(id)?.draft ?: plugs[id]?.schedule?.held?.let(::scheduleDraftOf)

internal fun DevicesView.scheduleSavable(id: String): Boolean {
	val draft = editOf(id)?.draft ?: return false
	val held = plugs[id]?.schedule?.held ?: return false
	return !busy(id) && draft.savable && draft != scheduleDraftOf(held)
}

internal fun DevicesView.addable(): List<DeviceCandidate>? {
	val found = scan as? ScanView.Found ?: return null
	val listed = list as? DeviceListView.Listed ?: return null
	return unpaired(found.candidates, listed.records)
}

internal fun DevicesView.paired(mac: String): Boolean = deviceRecord(this, mac) != null

internal fun DeviceSaved.keepsDraft(): Boolean =
	this is DeviceSaved.Unanswered || (this is DeviceSaved.Refused && code != Protocol.Wire.DeviceRefusalCode.STALE)
