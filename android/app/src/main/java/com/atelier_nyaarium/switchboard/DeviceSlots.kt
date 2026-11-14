package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceScanResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceListResult
import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.DeviceNearby
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.Protocol

internal sealed interface DeviceListView {
	data object Loading : DeviceListView

	data class Listed(val records: List<DeviceRecord>, val revision: Long) : DeviceListView

	data class Unavailable(val line: String) : DeviceListView

	/** Gateway lacks device support. */
	data object Declined : DeviceListView
}

internal sealed interface ScanView {
	data object Idle : ScanView

	data object Scanning : ScanView

	data class Found(
		val candidates: List<DeviceCandidate>,
		val nearby: List<DeviceNearby> = emptyList(),
		val bluetooth: Boolean? = null,
	) : ScanView

	data class Failed(val line: String) : ScanView
}

internal data class DeviceLive(
	val state: String,
	val stale: Boolean = false,
	val pending: Boolean? = null,
	val failed: String? = null,
)

internal val DeviceLive.confirmed: Boolean
	get() = state == Protocol.Wire.DeviceState.ON || state == Protocol.Wire.DeviceState.OFF

internal data class DeviceDetail(val schedule: DeviceSchedule, val settings: DeviceSettings?, val readAt: Long)

internal data class ScheduleEdit(val base: DeviceSchedule, val draft: ScheduleDraft)

internal data class ScheduleHeld(
	val held: DeviceSchedule? = null,
	val edit: ScheduleEdit? = null,
	val failed: String? = null,
)

internal data class SettingsHeld(val held: DeviceSettings? = null, val readAt: Long = 0L)

internal data class SensorHeld(val read: ConsoleDeviceReadResult.Sensor? = null, val failed: String? = null)

internal data class HeldDevice(
	val incarnation: Long,
	/** Kind when first listed. */
	val kind: String? = null,
	val live: DeviceLive? = null,
	val schedule: ScheduleHeld = ScheduleHeld(),
	val settings: SettingsHeld = SettingsHeld(),
	val sensor: SensorHeld = SensorHeld(),
)

internal data class Work(val busy: Boolean = false, val said: String? = null)

internal data class DevicesView(
	val list: DeviceListView = DeviceListView.Loading,
	val scan: ScanView = ScanView.Idle,
	val devices: Map<String, HeldDevice> = emptyMap(),
	val work: Map<String, Work> = emptyMap(),
	val minted: Long = 0L,
)

/** Where a device answer lands. */
internal sealed interface DeviceSlot<S> : Slot<DevicesView, S> {
	data object Listing : DeviceSlot<DeviceListView> {
		override fun read(view: DevicesView) = view.list

		override fun write(view: DevicesView, part: DeviceListView) = view.afterList(part)
	}

	data object Scan : DeviceSlot<ScanView> {
		override fun read(view: DevicesView) = view.scan

		override fun write(view: DevicesView, part: ScanView) = view.copy(scan = part)
	}

	data class Writing(val id: String) : DeviceSlot<Work> {
		override fun read(view: DevicesView) = view.work[id] ?: Work()

		override fun write(view: DevicesView, part: Work) = view.copy(work = view.work + (id to part))
	}

	sealed interface OfDevice<S> : DeviceSlot<S> {
		val id: String
		val incarnation: Long

		/** Listed answers prune devices. */
		override fun owned(view: DevicesView): Boolean = view.devices[id]?.incarnation == incarnation
	}

	data class Live(override val id: String, override val incarnation: Long) : OfDevice<DeviceLive?> {
		override fun read(view: DevicesView) = view.devices[id]?.live

		override fun write(view: DevicesView, part: DeviceLive?) = view.withDevice(id, incarnation) { copy(live = part) }
	}

	data class Schedule(override val id: String, override val incarnation: Long) : OfDevice<ScheduleHeld> {
		override fun read(view: DevicesView) = view.devices[id]?.schedule ?: ScheduleHeld()

		override fun write(view: DevicesView, part: ScheduleHeld) = view.withDevice(id, incarnation) { copy(schedule = part) }
	}

	data class Settings(override val id: String, override val incarnation: Long) : OfDevice<SettingsHeld> {
		override fun read(view: DevicesView) = view.devices[id]?.settings ?: SettingsHeld()

		override fun write(view: DevicesView, part: SettingsHeld) = view.withDevice(id, incarnation) { copy(settings = part) }
	}

	data class Sensor(override val id: String, override val incarnation: Long) : OfDevice<SensorHeld> {
		override fun read(view: DevicesView) = view.devices[id]?.sensor ?: SensorHeld()

		override fun write(view: DevicesView, part: SensorHeld) = view.withDevice(id, incarnation) { copy(sensor = part) }
	}
}

private inline fun DevicesView.withDevice(id: String, incarnation: Long, change: HeldDevice.() -> HeldDevice): DevicesView {
	val plug = devices[id]?.takeIf { it.incarnation == incarnation } ?: return this
	return copy(devices = devices + (id to plug.change()))
}

private fun DevicesView.afterList(list: DeviceListView): DevicesView {
	if (list !is DeviceListView.Listed) {
		return when (list) {
			is DeviceListView.Unavailable, DeviceListView.Declined, DeviceListView.Loading -> copy(list = list)
			is DeviceListView.Listed -> this
		}
	}
	var nextIncarnation = minted
	val nextDevices = list.records.associate { record ->
		val held = devices[record.id] ?: HeldDevice(incarnation = ++nextIncarnation, kind = record.kind)
		record.id to held
	}
	return copy(list = list, devices = nextDevices, minted = nextIncarnation)
}

/** Unreachable preserves listed devices. */
internal fun DeviceListView.afterList(answer: DeviceAnswer<ConsoleDeviceListResult>): DeviceListView =
	when (answer) {
		is DeviceAnswer.Answered -> when (val value = answer.value) {
			is ConsoleDeviceListResult.Ok -> DeviceListView.Listed(value.records, value.revision)
			is ConsoleDeviceListResult.Refused -> DeviceListView.Unavailable(refusalLine(value.refusal))
		}
		DeviceAnswer.Declined -> DeviceListView.Declined
		DeviceAnswer.Unreachable -> if (this is DeviceListView.Listed) this else DeviceListView.Unavailable(GATEWAY_UNREACHABLE)
	}

internal fun DeviceLive?.failedWith(line: String): DeviceLive =
	if (this != null && confirmed) copy(stale = true, pending = null, failed = line)
	else DeviceLive(Protocol.Wire.DeviceState.UNKNOWN, failed = line)

internal fun DeviceLive?.afterRead(answer: DeviceAnswer<ConsoleDeviceReadResult>): DeviceLive =
	when (answer) {
		is DeviceAnswer.Answered -> when (val value = answer.value) {
			is ConsoleDeviceReadResult.Ok -> DeviceLive(value.state.state)
			is ConsoleDeviceReadResult.Refused -> failedWith(refusalLine(value.refusal))
			is ConsoleDeviceReadResult.Sensor, is ConsoleDeviceReadResult.Unknown -> failedWith(NEWER_APP)
		}
		DeviceAnswer.Declined, DeviceAnswer.Unreachable -> failedWith(answer.unansweredLine())
	}

internal fun ScheduleHeld.afterRead(answer: DeviceAnswer<ConsoleDeviceReadResult>): ScheduleHeld =
	when (answer) {
		is DeviceAnswer.Answered -> when (val value = answer.value) {
			is ConsoleDeviceReadResult.Ok -> copy(
				held = value.schedule,
				edit = edit?.takeIf { it.base == value.schedule },
				failed = null,
			)
			is ConsoleDeviceReadResult.Refused -> copy(failed = refusalLine(value.refusal))
			is ConsoleDeviceReadResult.Sensor, is ConsoleDeviceReadResult.Unknown -> copy(failed = NEWER_APP)
		}
		DeviceAnswer.Declined, DeviceAnswer.Unreachable -> copy(failed = answer.unansweredLine())
	}

internal fun SettingsHeld.afterRead(answer: DeviceAnswer<ConsoleDeviceReadResult>): SettingsHeld =
	when (answer) {
		is DeviceAnswer.Answered -> when (val value = answer.value) {
			is ConsoleDeviceReadResult.Ok -> copy(held = value.settings, readAt = value.state.readAt)
			is ConsoleDeviceReadResult.Refused, is ConsoleDeviceReadResult.Sensor, is ConsoleDeviceReadResult.Unknown -> this
		}
		DeviceAnswer.Declined, DeviceAnswer.Unreachable -> this
	}

/** Failure preserves prior readings. */
internal fun SensorHeld.afterRead(answer: DeviceAnswer<ConsoleDeviceReadResult>): SensorHeld =
	when (answer) {
		is DeviceAnswer.Answered -> when (val value = answer.value) {
			is ConsoleDeviceReadResult.Sensor -> SensorHeld(read = value)
			is ConsoleDeviceReadResult.Refused -> copy(failed = refusalLine(value.refusal))
			is ConsoleDeviceReadResult.Ok, is ConsoleDeviceReadResult.Unknown -> copy(failed = NEWER_APP)
		}
		DeviceAnswer.Declined, DeviceAnswer.Unreachable -> copy(failed = answer.unansweredLine())
	}

internal fun ScheduleHeld.afterPut(schedule: DeviceSchedule): ScheduleHeld =
	copy(held = schedule, edit = null, failed = null)

internal fun ScheduleHeld.rebased(draft: ScheduleDraft): ScheduleHeld =
	held?.let { copy(edit = ScheduleEdit(it, draft), failed = null) } ?: this

internal fun SettingsHeld.afterPut(answer: DeviceSettings): SettingsHeld {
	val kept = held
	val settings = if (answer is DeviceSettings.Kasa && kept is DeviceSettings.Kasa) answer.copy(clock = kept.clock) else answer
	return copy(held = settings)
}

internal fun ScheduleHeld.editDraft(draft: ScheduleDraft): ScheduleHeld {
	val base = edit?.base ?: held ?: return this
	return copy(edit = ScheduleEdit(base, draft))
}

internal fun ScanView.afterScan(answer: DeviceAnswer<ConsoleDeviceScanResult>): ScanView {
	if (answer !is DeviceAnswer.Answered) return ScanView.Failed(answer.unansweredLine())
	return when (val value = answer.value) {
		is ConsoleDeviceScanResult.Ok -> ScanView.Found(value.candidates, value.nearby.orEmpty(), value.bluetooth)
		is ConsoleDeviceScanResult.Refused -> ScanView.Failed(refusalLine(value.refusal))
	}
}
