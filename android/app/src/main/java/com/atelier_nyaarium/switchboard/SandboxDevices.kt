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
import com.atelier_nyaarium.switchboard.proto.DeviceLiveState
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceRefusal
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceScheduleRule
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.KasaClock
import com.atelier_nyaarium.switchboard.proto.KasaSettingPut
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.time.OffsetDateTime
import java.time.ZoneId
import kotlinx.coroutines.delay

// Invented MACs and addresses.
private const val LAMP = "02:00:00:00:00:01"
private const val FAN = "02:00:00:00:00:02"
private const val PORCH = "02:00:00:00:00:03"

private fun record(id: String, name: String, address: String) =
	DeviceRecord(id = id, name = name, kind = "switch", driver = "kasa", address = address, revision = 1L)

private fun <T> answered(value: T): DeviceAnswer<T> = DeviceAnswer.Answered(value)

private class SandboxPlugs(seeded: Boolean) {
	var revision = 1L
	var scans = 0
	val records = if (seeded) {
		mutableMapOf(
			LAMP to record(LAMP, "Desk lamp", "192.0.2.11"),
			PORCH to record(PORCH, "Porch light", "192.0.2.13"),
		)
	} else {
		mutableMapOf()
	}
	val relays = mutableMapOf(LAMP to true, FAN to false)
	val schedules = mutableMapOf(
		LAMP to DeviceSchedule(
			enabled = true,
			rules = listOf(
				DeviceScheduleRule(id = "dusk", days = List(7) { true }, time = "18:30", action = "on", enabled = true),
				DeviceScheduleRule(id = "night", days = List(7) { true }, time = "23:00", action = "off", enabled = true),
			),
		),
	)
	val settings = mutableMapOf<String, DeviceSettings.Kasa>()
}

/** Canned plugs; mutations persist. */
internal class SandboxDeviceGateway(
	private val pause: suspend (Long) -> Unit = { delay(it) },
	private val setUp: () -> DeviceCandidate? = { null },
) : DeviceGateway {
	private val gateways = mutableMapOf<String, SandboxPlugs>()

	private val found = listOf(
		DeviceCandidate(mac = LAMP, address = "192.0.2.11", alias = "Desk lamp", model = "HS103(US)", hardware = "3.0", firmware = "1.0.3"),
		DeviceCandidate(mac = FAN, address = "192.0.2.12", alias = "Fan", model = "HS103(US)", hardware = "3.0", firmware = "1.0.3"),
	)

	private fun plugs(gatewayId: String) = gateways.getOrPut(gatewayId) { SandboxPlugs(seeded = gatewayId != EMPTY_GATEWAY) }

	private fun refusal(code: String, record: DeviceRecord? = null) =
		DeviceRefusal(code = code, effect = Protocol.Wire.DeviceEffect.NONE, record = record)

	/** Not found or stale. */
	private fun SandboxPlugs.misfit(id: String, revision: Long): DeviceRefusal? {
		val held = records[id] ?: return refusal(Protocol.Wire.DeviceRefusalCode.NOT_FOUND)
		return if (held.revision != revision) refusal(Protocol.Wire.DeviceRefusalCode.STALE, held) else null
	}

	private fun SandboxPlugs.settingsOf(id: String): DeviceSettings.Kasa {
		val held = settings.getOrPut(id) { DeviceSettings.Kasa(led = true, clock = plugClock(), cloud = "bound") }
		return held.copy(clock = plugClock())
	}

	private fun plugClock() = KasaClock(
		time = OffsetDateTime.now(ZoneId.of("America/Los_Angeles")).plusMinutes(4).withNano(0).toString(),
		zone = "PST8PDT",
	)

	private val silent = refusal(Protocol.Wire.DeviceRefusalCode.UNREACHABLE)

	/** Simulated latency. */
	private suspend fun trip() = pause(150)

	override suspend fun list(gatewayId: String): DeviceAnswer<ConsoleDeviceListResult> {
		trip()
		val plugs = plugs(gatewayId)
		return answered(ConsoleDeviceListResult.Ok(records = plugs.records.values.sortedBy { it.name }, revision = plugs.revision))
	}

	override suspend fun read(gatewayId: String, id: String): DeviceAnswer<ConsoleDeviceReadResult> {
		trip()
		val plugs = plugs(gatewayId)
		if (id !in plugs.records) return answered(ConsoleDeviceReadResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.NOT_FOUND)))
		if (id == PORCH) return answered(ConsoleDeviceReadResult.Refused(silent))
		return answered(
			ConsoleDeviceReadResult.Ok(
				state = DeviceLiveState(state = if (plugs.relays[id] == true) "on" else "off", readAt = System.currentTimeMillis()),
				schedule = plugs.schedules[id] ?: DeviceSchedule(enabled = true, rules = emptyList()),
				settings = plugs.settingsOf(id),
			),
		)
	}

	/** Every second scan fails. */
	override suspend fun scan(gatewayId: String): DeviceAnswer<ConsoleDeviceScanResult> {
		pause(1_200)
		val plugs = plugs(gatewayId)
		plugs.scans += 1
		if (plugs.scans % 2 == 0) {
			return answered(ConsoleDeviceScanResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.DAEMON_AWAY)))
		}
		return answered(ConsoleDeviceScanResult.Ok(found + listOfNotNull(setUp())))
	}

	override suspend fun homeNetwork(gatewayId: String): DeviceAnswer<ConsoleDeviceHomeNetworkResult> {
		trip()
		return answered(ConsoleDeviceHomeNetworkResult.Ok(ssid = "Sandbox Home".takeIf { gatewayId != EMPTY_GATEWAY }))
	}

	override suspend fun add(gatewayId: String, mac: String, address: String, name: String): DeviceAnswer<ConsoleDeviceAddResult> {
		trip()
		val plugs = plugs(gatewayId)
		plugs.records[mac]?.let { return answered(ConsoleDeviceAddResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.EXISTS, it))) }
		plugs.revision += 1
		val added = DeviceRecord(id = mac, name = name, kind = "switch", driver = "kasa", address = address, revision = 1L)
		plugs.records[mac] = added
		return answered(ConsoleDeviceAddResult.Ok(added))
	}

	override suspend fun rename(gatewayId: String, id: String, name: String, revision: Long): DeviceAnswer<ConsoleDeviceRenameResult> {
		trip()
		val plugs = plugs(gatewayId)
		plugs.misfit(id, revision)?.let { return answered(ConsoleDeviceRenameResult.Refused(it)) }
		val renamed = plugs.records.getValue(id).let { it.copy(name = name, revision = it.revision + 1) }
		plugs.records[id] = renamed
		plugs.revision += 1
		return answered(ConsoleDeviceRenameResult.Ok(renamed))
	}

	override suspend fun remove(gatewayId: String, id: String, revision: Long): DeviceAnswer<ConsoleDeviceRemoveResult> {
		trip()
		val plugs = plugs(gatewayId)
		plugs.misfit(id, revision)?.let { return answered(ConsoleDeviceRemoveResult.Refused(it)) }
		plugs.records.remove(id)
		plugs.revision += 1
		return answered(ConsoleDeviceRemoveResult.Ok)
	}

	override suspend fun set(gatewayId: String, id: String, verb: String): DeviceAnswer<ConsoleDeviceSetResult> {
		trip()
		val plugs = plugs(gatewayId)
		if (id !in plugs.records) return answered(ConsoleDeviceSetResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.NOT_FOUND)))
		if (id == PORCH) return answered(ConsoleDeviceSetResult.Refused(silent))
		plugs.relays[id] = verb == Protocol.Wire.DeviceVerb.ON
		return answered(ConsoleDeviceSetResult.Ok(DeviceLiveState(state = verb, readAt = System.currentTimeMillis())))
	}

	override suspend fun schedulePut(
		gatewayId: String,
		id: String,
		revision: Long,
		base: DeviceSchedule,
		schedule: DeviceSchedule,
	): DeviceAnswer<ConsoleDeviceSchedulePutResult> {
		trip()
		val plugs = plugs(gatewayId)
		plugs.misfit(id, revision)?.let { return answered(ConsoleDeviceSchedulePutResult.Refused(it)) }
		if ((plugs.schedules[id] ?: DeviceSchedule(enabled = true, rules = emptyList())) != base) {
			return answered(ConsoleDeviceSchedulePutResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.STALE)))
		}
		var next = 0
		val stored = schedule.copy(rules = schedule.rules.map { it.copy(id = it.id ?: "rule-${++next}-${schedule.rules.size}") })
		plugs.schedules[id] = stored
		return answered(ConsoleDeviceSchedulePutResult.Ok(stored))
	}

	override suspend fun settingPut(
		gatewayId: String,
		id: String,
		revision: Long,
		setting: DeviceSettingPut,
	): DeviceAnswer<ConsoleDeviceSettingPutResult> {
		trip()
		val plugs = plugs(gatewayId)
		plugs.misfit(id, revision)?.let { return answered(ConsoleDeviceSettingPutResult.Refused(it)) }
		val held = plugs.settingsOf(id)
		plugs.settings[id] = when (val put = (setting as DeviceSettingPut.Kasa).setting) {
			is KasaSettingPut.Led -> held.copy(led = put.value)
			is KasaSettingPut.Cloud -> held.copy(cloud = put.value)
		}
		return answered(ConsoleDeviceSettingPutResult.Ok(plugs.settingsOf(id)))
	}
}
