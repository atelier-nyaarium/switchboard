package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceAddResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceRemoveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceRenameResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceHomeNetworkResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceScanResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSchedulePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSettingPutResult
import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceRefusal
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

internal const val GATEWAY_DECLINED = "This Gateway does not offer devices"

internal sealed interface DeviceAnswer<out T> {
	data class Answered<T>(val value: T) : DeviceAnswer<T>

	data object Declined : DeviceAnswer<Nothing>

	data object Unreachable : DeviceAnswer<Nothing>
}

internal fun DeviceAnswer<*>.unansweredLine(): String =
	if (this is DeviceAnswer.Declined) GATEWAY_DECLINED else GATEWAY_UNREACHABLE

internal interface DeviceGateway {
	suspend fun list(gatewayId: String): DeviceAnswer<ConsoleDeviceListResult>

	suspend fun read(gatewayId: String, id: String): DeviceAnswer<ConsoleDeviceReadResult>

	suspend fun scan(gatewayId: String): DeviceAnswer<ConsoleDeviceScanResult>

	suspend fun homeNetwork(gatewayId: String): DeviceAnswer<ConsoleDeviceHomeNetworkResult>

	suspend fun add(gatewayId: String, mac: String, address: String, name: String): DeviceAnswer<ConsoleDeviceAddResult>

	suspend fun rename(gatewayId: String, id: String, name: String, revision: Long): DeviceAnswer<ConsoleDeviceRenameResult>

	suspend fun remove(gatewayId: String, id: String, revision: Long): DeviceAnswer<ConsoleDeviceRemoveResult>

	suspend fun set(gatewayId: String, id: String, verb: String): DeviceAnswer<ConsoleDeviceSetResult>

	suspend fun schedulePut(
		gatewayId: String,
		id: String,
		revision: Long,
		base: DeviceSchedule,
		schedule: DeviceSchedule,
	): DeviceAnswer<ConsoleDeviceSchedulePutResult>

	suspend fun settingPut(
		gatewayId: String,
		id: String,
		revision: Long,
		setting: DeviceSettingPut,
	): DeviceAnswer<ConsoleDeviceSettingPutResult>
}

internal interface DeviceHost {
	val gateway: DeviceGateway?
	val generation: WorkspaceGeneration

	fun names(gatewayId: String): Boolean
}

internal sealed interface DeviceSaved {
	data class Stored(val record: DeviceRecord?) : DeviceSaved

	data class Refused(val line: String, val code: String) : DeviceSaved

	data class Unanswered(val line: String) : DeviceSaved

	data object Busy : DeviceSaved
}

internal fun refusalLine(refusal: DeviceRefusal): String {
	val code = Protocol.Wire.DeviceRefusalCode
	val unknown = refusal.effect == Protocol.Wire.DeviceEffect.UNKNOWN
	val base = when (refusal.code) {
		code.NOT_FOUND -> "No longer paired"
		code.STALE -> "Changed elsewhere"
		code.EXISTS -> "Already paired"
		code.FULL -> "Plug limit reached"
		code.INVALID -> refusal.detail ?: "Not valid"
		code.WRONG_DEVICE -> "That address answers a different plug"
		code.NOT_SUPPORTED -> "Not supported on this plug"
		code.TOGGLE_UNKNOWN -> "Read the plug first"
		code.UNREACHABLE -> "The plug did not answer"
		code.TIMEOUT -> if (unknown) "No answer in time" else "Took too long; nothing changed"
		code.DEVICE_ERROR -> "The plug refused" + (refusal.detail?.let { " ($it)" } ?: "")
		code.WRITE_FAILED -> "Not saved"
		code.DAEMON_AWAY -> "The host daemon is not running"
		code.SCAN_FAILED -> "The scan could not run"
		else -> refusal.code
	}
	val landed = refusal.landed?.let { "; ${it.done} of ${it.total} changes landed" } ?: ""
	val changed = if (unknown) "; the plug may have changed" else ""
	return base + landed + changed
}

internal fun unpaired(found: List<DeviceCandidate>, records: List<DeviceRecord>): List<DeviceCandidate> =
	found.filter { candidate -> records.none { it.id == candidate.mac } }

/** Every device call and landing. */
internal class DeviceOps(private val host: DeviceHost) : ClearsOnReprovision {
	private val slots = SlotViews<String, DevicesView>(host.generation, ::DevicesView)

	val views get() = slots.all

	fun view(gatewayId: String): DevicesView = slots.of(gatewayId) ?: DevicesView()

	override suspend fun clearInMemory() = slots.clear()

	fun editDraft(gatewayId: String, id: String, draft: ScheduleDraft) {
		val held = view(gatewayId).plugs[id] ?: return
		slots.now(gatewayId, DeviceSlot.Schedule(id, held.incarnation)) { it.editDraft(draft) }
	}

	fun discardDraft(gatewayId: String, id: String) {
		val held = view(gatewayId).plugs[id] ?: return
		slots.now(gatewayId, DeviceSlot.Schedule(id, held.incarnation)) { it.copy(edit = null) }
	}

	fun forget(gatewayId: String, id: String) {
		slots.now(gatewayId, DeviceSlot.Writing(id)) { it.copy(said = null) }
	}

	suspend fun refresh(gatewayId: String) {
		relist(gatewayId)
		val records = (view(gatewayId).list as? DeviceListView.Listed)?.records ?: return
		coroutineScope { records.map { async { read(gatewayId, it.id) } }.awaitAll() }
	}

	suspend fun open(gatewayId: String, id: String) {
		relist(gatewayId)
		read(gatewayId, id)
	}

	suspend fun relist(gatewayId: String) {
		val ticket = slots.begin(gatewayId, DeviceSlot.Listing)
		val answer = ask(gatewayId) { it.list(gatewayId) }
		slots.land(ticket) { it.afterList(answer) }
	}

	suspend fun read(gatewayId: String, id: String) {
		val plug = slots.of(gatewayId)?.plugs?.get(id) ?: return
		val liveTicket = slots.begin(gatewayId, DeviceSlot.Live(id, plug.incarnation))
		val scheduleTicket = slots.begin(gatewayId, DeviceSlot.Schedule(id, plug.incarnation))
		val settingsTicket = slots.begin(gatewayId, DeviceSlot.Settings(id, plug.incarnation))
		val answer = ask(gatewayId) { it.read(gatewayId, id) }
		val liveLanded = slots.land(liveTicket) { it.afterRead(answer) }
		val scheduleLanded = slots.land(scheduleTicket) { it.afterRead(answer) }
		val settingsLanded = slots.land(settingsTicket) { it.afterRead(answer) }
		val refusal = ((answer as? DeviceAnswer.Answered)?.value as? ConsoleDeviceReadResult.Refused)?.refusal
		if (refusal?.code == Protocol.Wire.DeviceRefusalCode.NOT_FOUND && (liveLanded || scheduleLanded || settingsLanded)) {
			relist(gatewayId)
		}
	}

	private fun <S> beginPlug(
		gatewayId: String,
		id: String,
		slot: (Long) -> DeviceSlot<S>,
	): SlotViews.Ticket<String, DevicesView, S>? {
		val plug = slots.of(gatewayId)?.plugs?.get(id) ?: return null
		return slots.begin(gatewayId, slot(plug.incarnation))
	}

	/** Flips optimistically. */
	suspend fun set(gatewayId: String, id: String, on: Boolean) {
		write(gatewayId, id, call = { client, _ ->
			val liveTicket = beginPlug(gatewayId, id) { DeviceSlot.Live(id, it) }
				?: return@write DeviceSaved.Unanswered(GATEWAY_UNREACHABLE)
			slots.land(liveTicket) { live ->
				(live ?: DeviceLive(Protocol.Wire.DeviceState.UNKNOWN)).copy(pending = on)
			}
			val verb = if (on) Protocol.Wire.DeviceVerb.ON else Protocol.Wire.DeviceVerb.OFF
			val answer = invoke(client) { it.set(gatewayId, id, verb) }
			val saved = when (answer) {
				is DeviceAnswer.Answered -> when (val value = answer.value) {
					is ConsoleDeviceSetResult.Ok -> {
						slots.land(liveTicket) { DeviceLive(value.state.state) }
						DeviceSaved.Stored(null)
					}
					is ConsoleDeviceSetResult.Refused -> {
						slots.land(liveTicket) { it.failedWith(refusalLine(value.refusal)) }
						refused(value.refusal)
					}
				}
				DeviceAnswer.Declined, DeviceAnswer.Unreachable -> {
					slots.land(liveTicket) { it.failedWith(answer.unansweredLine()) }
					DeviceSaved.Unanswered(answer.unansweredLine())
				}
			}
			if (saved !is DeviceSaved.Stored) read(gatewayId, id)
			saved
		})
	}

	/** Rereads plugs it moved. */
	suspend fun scan(gatewayId: String) {
		val before = (view(gatewayId).list as? DeviceListView.Listed)?.records.orEmpty().associate { it.id to it.address }
		val ticket = slots.begin(gatewayId, DeviceSlot.Scan)
		if (!slots.land(ticket) { ScanView.Scanning }) return
		val answer = ask(gatewayId) { it.scan(gatewayId) }
		if (!slots.land(ticket) { it.afterScan(answer) }) return
		relist(gatewayId)
		val moved = (view(gatewayId).list as? DeviceListView.Listed)?.records.orEmpty()
			.filter { record -> before[record.id].let { it != null && it != record.address } }
		coroutineScope { moved.map { async { read(gatewayId, it.id) } }.awaitAll() }
	}

	suspend fun add(gatewayId: String, candidate: DeviceCandidate, name: String): DeviceSaved =
		write(gatewayId, candidate.mac, call = { client, _ ->
			saved(invoke(client) { it.add(gatewayId, candidate.mac, candidate.address, name) }) { value ->
				when (value) {
					is ConsoleDeviceAddResult.Ok -> DeviceSaved.Stored(value.record)
					is ConsoleDeviceAddResult.Refused -> refused(value.refusal)
				}
			}
		}) { result ->
			when (result) {
				is DeviceSaved.Stored -> refresh(gatewayId)
				DeviceSaved.Busy -> Unit
				else -> relist(gatewayId)
			}
		}

	suspend fun rename(gatewayId: String, record: DeviceRecord, name: String): DeviceSaved =
		write(gatewayId, record.id, call = { client, _ ->
			saved(invoke(client) { it.rename(gatewayId, record.id, name, record.revision) }) { value ->
				when (value) {
					is ConsoleDeviceRenameResult.Ok -> DeviceSaved.Stored(value.record)
					is ConsoleDeviceRenameResult.Refused -> refused(value.refusal)
				}
			}
		}) { result -> if (result != DeviceSaved.Busy) relist(gatewayId) }

	suspend fun remove(gatewayId: String, record: DeviceRecord): DeviceSaved =
		write(gatewayId, record.id, call = { client, _ ->
			saved(invoke(client) { it.remove(gatewayId, record.id, record.revision) }) { value ->
				when (value) {
					ConsoleDeviceRemoveResult.Ok -> DeviceSaved.Stored(null)
					is ConsoleDeviceRemoveResult.Refused -> refused(value.refusal)
				}
			}
		}) { result -> if (result != DeviceSaved.Busy) relist(gatewayId) }

	suspend fun putSchedule(
		gatewayId: String,
		record: DeviceRecord,
		base: DeviceSchedule,
		schedule: DeviceSchedule,
	): DeviceSaved {
		val generation = host.generation.capture()
		var scheduleTicket: SlotViews.Ticket<String, DevicesView, ScheduleHeld>? = null
		var rebase: ScheduleDraft? = null
		return write(gatewayId, record.id, call = { client, _ ->
			val ticket = beginPlug(gatewayId, record.id) { DeviceSlot.Schedule(record.id, it) }
				?: return@write DeviceSaved.Unanswered(GATEWAY_UNREACHABLE)
			scheduleTicket = ticket
			val editBase = view(gatewayId).editOf(record.id)?.base ?: base
			saved(invoke(client) { it.schedulePut(gatewayId, record.id, record.revision, editBase, schedule) }) { value ->
				when (value) {
					is ConsoleDeviceSchedulePutResult.Ok -> {
						val landed = slots.land(ticket) { it.afterPut(value.schedule) }
						if (!landed && host.generation.isCurrent(generation)) {
							slots.now(gatewayId, ticket.slot) { it.copy(edit = null) }
						}
						DeviceSaved.Stored(record)
					}
					is ConsoleDeviceSchedulePutResult.Refused -> refused(value.refusal)
				}
			}
		}) { result ->
			if (result.keepsDraft()) rebase = view(gatewayId).editOf(record.id)?.draft
			if (result !is DeviceSaved.Stored && result != DeviceSaved.Busy) settle(gatewayId, record.id)
			val ticket = scheduleTicket
			val draft = rebase
			if (ticket != null && draft != null && result.keepsDraft() && host.generation.isCurrent(generation)) {
				slots.now(gatewayId, ticket.slot) { it.rebased(draft) }
			}
		}
	}

	suspend fun putSetting(gatewayId: String, record: DeviceRecord, setting: DeviceSettingPut): DeviceSaved =
		write(gatewayId, record.id, call = { client, _ ->
			val ticket = beginPlug(gatewayId, record.id) { DeviceSlot.Settings(record.id, it) }
				?: return@write DeviceSaved.Unanswered(GATEWAY_UNREACHABLE)
			saved(invoke(client) { it.settingPut(gatewayId, record.id, record.revision, setting) }) { value ->
				when (value) {
					is ConsoleDeviceSettingPutResult.Ok -> {
						slots.land(ticket) { it.afterPut(value.settings) }
						DeviceSaved.Stored(record)
					}
					is ConsoleDeviceSettingPutResult.Refused -> refused(value.refusal)
				}
			}
		}) { result ->
			if (result !is DeviceSaved.Stored && result != DeviceSaved.Busy) settle(gatewayId, record.id)
		}

	private suspend fun settle(gatewayId: String, id: String) {
		relist(gatewayId)
		read(gatewayId, id)
	}

	private suspend fun write(
		gatewayId: String,
		id: String,
		call: suspend (DeviceGateway, SlotViews.Ticket<String, DevicesView, Work>) -> DeviceSaved,
		settle: suspend (DeviceSaved) -> Unit = {},
	): DeviceSaved {
		val client = host.gateway?.takeIf { host.names(gatewayId) }
		if (client == null) {
			slots.now(gatewayId, DeviceSlot.Writing(id)) { it.copy(said = GATEWAY_UNREACHABLE) }
			return DeviceSaved.Unanswered(GATEWAY_UNREACHABLE)
		}
		val ticket = slots.begin(gatewayId, DeviceSlot.Writing(id))
		if (!slots.claim(ticket, take = { !it.busy }, taken = { it.copy(busy = true) })) return DeviceSaved.Busy
		var result: DeviceSaved? = null
		try {
			val saved = runCatchingCancellable { call(client, ticket) }.getOrElse { error ->
				DebugLog.log("Device", "gateway call failed: ${error.message}")
				DeviceSaved.Unanswered(GATEWAY_UNREACHABLE)
			}
			result = saved
			settle(saved)
			return saved
		} finally {
			val line = result.lineOrNull()
			slots.land(ticket) { it.copy(busy = false, said = line) }
		}
	}

	/** The WiFi the Gateway's host is on; null for any other answer. */
	suspend fun homeNetwork(gatewayId: String): String? =
		((ask(gatewayId) { it.homeNetwork(gatewayId) } as? DeviceAnswer.Answered)?.value as? ConsoleDeviceHomeNetworkResult.Ok)?.ssid

	private suspend fun <T> ask(gatewayId: String, call: suspend (DeviceGateway) -> DeviceAnswer<T>): DeviceAnswer<T> {
		if (!host.names(gatewayId)) return DeviceAnswer.Unreachable
		val client = host.gateway ?: return DeviceAnswer.Unreachable
		return invoke(client, call)
	}

	private suspend fun <T> invoke(client: DeviceGateway, call: suspend (DeviceGateway) -> DeviceAnswer<T>): DeviceAnswer<T> =
		runCatchingCancellable { call(client) }.getOrElse { error ->
			DebugLog.log("Device", "gateway call failed: ${error.message}")
			DeviceAnswer.Unreachable
		}

	private inline fun <T> saved(answer: DeviceAnswer<T>, answered: (T) -> DeviceSaved): DeviceSaved =
		if (answer is DeviceAnswer.Answered) answered(answer.value) else DeviceSaved.Unanswered(answer.unansweredLine())

	private fun refused(refusal: DeviceRefusal) = DeviceSaved.Refused(refusalLine(refusal), refusal.code)

	private fun DeviceSaved?.lineOrNull(): String? = when (this) {
		is DeviceSaved.Refused -> line
		is DeviceSaved.Unanswered -> line
		else -> null
	}
}
