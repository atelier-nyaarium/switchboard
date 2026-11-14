package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceAddResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadingPostResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSensorThresholdPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceExtreme
import com.atelier_nyaarium.switchboard.proto.DeviceReading
import com.atelier_nyaarium.switchboard.proto.DeviceSensorPayload
import com.atelier_nyaarium.switchboard.proto.DeviceSensorThreshold
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
import com.atelier_nyaarium.switchboard.proto.DeviceNearby
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Invented MACs and addresses.
private const val LAMP = "02:00:00:00:00:01"
private const val FAN = "02:00:00:00:00:02"
private const val PORCH = "02:00:00:00:00:03"
private const val FREEZER = "02:00:00:00:00:11"
private const val KITCHEN = "02:00:00:00:00:12"
private const val SHED = "02:00:00:00:00:13"
private const val GARAGE = "02:00:00:00:00:14"
private const val H5110 = "govee-h5110"

private fun record(id: String, name: String, address: String) =
	DeviceRecord(id = id, name = name, kind = "switch", driver = "kasa", address = address, revision = 1L)

private fun sensor(id: String, name: String, radio: String, definition: String?) = DeviceRecord(
	id = id,
	name = name,
	kind = Protocol.Wire.DeviceKind.SENSOR,
	driver = Protocol.Wire.DeviceDriver.GOVEE,
	address = id,
	radio = radio,
	definition = definition,
	revision = 1L,
)

private val TEMPERATURE = AssistantFieldSpec.Number(field = "temperature", label = "Temperature", unit = "C", decimals = 1)
private val HUMIDITY = AssistantFieldSpec.Number(field = "humidity", label = "Humidity", unit = "%", decimals = 1)
private val BATTERY = AssistantFieldSpec.Number(field = "battery", label = "Battery", unit = "%", decimals = 0)

private class SensorFeed(val temperature: Double, val humidity: Double, val battery: Double, val heardAgoMs: Long)

private const val MINUTE = 60_000L

private val FEEDS = mapOf(
	FREEZER to SensorFeed(temperature = -18.2, humidity = 61.2, battery = 90.0, heardAgoMs = MINUTE),
	KITCHEN to SensorFeed(temperature = 21.8, humidity = 44.0, battery = 70.0, heardAgoMs = 3 * MINUTE),
	SHED to SensorFeed(temperature = 12.2, humidity = 80.5, battery = 15.0, heardAgoMs = 120 * MINUTE),
)

private fun reading(spec: AssistantFieldSpec.Number, value: Double, now: Long, alerts: List<String>) = DeviceReading(
	spec = spec,
	value = JsonPrimitive(value),
	low = DeviceExtreme(value = value - 1.6, at = now - 9 * 60 * MINUTE),
	high = DeviceExtreme(value = value + 3.9, at = now - 3 * 60 * MINUTE),
	alerts = alerts,
)

private const val FOUND_TESTED = "02:00:00:00:00:21"
private const val FOUND_RAW = "02:00:00:00:00:22"

private fun goveeNearby(mac: String, name: String, hex: String, signal: Long) = DeviceNearby(
	mac = mac,
	radio = Protocol.Wire.DeviceRadio.GATEWAY,
	name = name,
	signal = signal,
	data = JsonObject(mapOf("1" to JsonPrimitive(hex))),
	services = listOf("ec88"),
)

/** Each Gateway hears differently. */
private fun nearbyOn(gatewayId: String): List<DeviceNearby> = when (gatewayId) {
	EMPTY_GATEWAY -> emptyList()
	SECOND_SANDBOX_GATEWAY -> listOf(goveeNearby(FOUND_TESTED, "GVH5110_3C5D", "010103bac864", -84))
	else -> listOf(
		goveeNearby(FOUND_TESTED, "GVH5110_3C5D", "010103bac864", -61),
		goveeNearby(FOUND_RAW, "Govee_H5199_7F01", "0101027a3f550000", -73),
	)
}

/** Sandbox phone hears both. */
internal class SandboxBlePlatform : BlePlatform {
	override fun readiness() = RadioReadiness.READY

	override suspend fun scan(windowMs: Long): List<Sighting> {
		delay(1_500)
		return listOf(
			Sighting(FOUND_TESTED, -70, Advert("GVH5110_3C5D", mapOf("1" to "010103bac864"), listOf("ec88"))),
			Sighting(FOUND_RAW, -58, Advert("Govee_H5199_7F01", mapOf("1" to "0101027a3f550000"), listOf("ec88"))),
		)
	}

	override fun watch(addresses: Set<String>) = true
}

/** One payload byte drifts. */
private fun payloads(now: Long): List<DeviceSensorPayload> =
	listOf("7a3f", "79b4", "77c1", "8002").mapIndexed { at, drift ->
		DeviceSensorPayload(
			name = "Govee_H5199_7F01",
			data = JsonObject(mapOf("1" to JsonPrimitive("010102${drift}550000"))),
			services = emptyList(),
			at = now - (40_000L + at * 5 * MINUTE),
			radio = if (at == 1) Protocol.Wire.DeviceRadio.PHONES else Protocol.Wire.DeviceRadio.GATEWAY,
		)
	}

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
	val thresholds = mutableMapOf<Pair<String, String>, DeviceSensorThreshold>()
}

private fun SandboxPlugs.seedSensors(gatewayId: String) {
	val held = when (gatewayId) {
		EMPTY_GATEWAY -> emptyList()
		SECOND_SANDBOX_GATEWAY -> listOf(
			sensor(SHED, "Shed", Protocol.Wire.DeviceRadio.GATEWAY, H5110),
			sensor(GARAGE, "Garage", Protocol.Wire.DeviceRadio.GATEWAY, null),
		)
		else -> listOf(
			sensor(FREEZER, "Freezer", Protocol.Wire.DeviceRadio.GATEWAY, H5110),
			sensor(KITCHEN, "Kitchen", Protocol.Wire.DeviceRadio.PHONES, H5110),
		)
	}
	for (record in held) records[record.id] = record
	if (FREEZER in records) {
		thresholds[FREEZER to "temperature"] =
			DeviceSensorThreshold(measure = "temperature", low = -28.9, high = -12.2, deadZone = 1.1, coolDownSec = 0, revision = 1)
	}
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

	private fun plugs(gatewayId: String) =
		gateways.getOrPut(gatewayId) { SandboxPlugs(seeded = gatewayId != EMPTY_GATEWAY).also { it.seedSensors(gatewayId) } }

	private fun SandboxPlugs.sensorRead(record: DeviceRecord): ConsoleDeviceReadResult.Sensor {
		val now = System.currentTimeMillis()
		val feed = FEEDS[record.id]
		if (record.definition == null || feed == null) {
			return ConsoleDeviceReadResult.Sensor(readings = emptyList(), heardAt = now - 40_000, payloads = payloads(now))
		}
		val stale = if (feed.heardAgoMs > 15 * MINUTE) "not heard in 15 minutes" else null
		return ConsoleDeviceReadResult.Sensor(
			readings = listOf(
				reading(TEMPERATURE, feed.temperature, now, listOf("low", "high")),
				reading(HUMIDITY, feed.humidity, now, listOf("low")),
				reading(BATTERY, feed.battery, now, listOf("low")),
			),
			model = "H5110",
			heardAt = now - feed.heardAgoMs,
			stale = stale,
			thresholds = thresholds.filterKeys { it.first == record.id }.values.sortedBy { it.measure },
		)
	}

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
		val held = plugs.records[id] ?: return answered(ConsoleDeviceReadResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.NOT_FOUND)))
		if (held.kind == Protocol.Wire.DeviceKind.SENSOR) return answered(plugs.sensorRead(held))
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
		return answered(ConsoleDeviceScanResult.Ok(found + listOfNotNull(setUp()), nearby = nearbyOn(gatewayId), bluetooth = gatewayId != EMPTY_GATEWAY))
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

	override suspend fun addSensor(
		gatewayId: String,
		mac: String,
		name: String,
		radio: String,
		definition: String?,
		advert: DeviceAdvert?,
	): DeviceAnswer<ConsoleDeviceAddResult> {
		trip()
		val plugs = plugs(gatewayId)
		plugs.records[mac]?.let { return answered(ConsoleDeviceAddResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.EXISTS, it))) }
		plugs.revision += 1
		val added = sensor(mac, name, radio, definition)
		plugs.records[mac] = added
		return answered(ConsoleDeviceAddResult.Ok(added))
	}

	override suspend fun postReading(gatewayId: String, id: String, advert: DeviceAdvert, at: Long): DeviceAnswer<ConsoleDeviceReadingPostResult> {
		trip()
		val held = plugs(gatewayId).records[id]
			?: return answered(ConsoleDeviceReadingPostResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.NOT_FOUND)))
		if (held.radio != Protocol.Wire.DeviceRadio.PHONES) {
			return answered(ConsoleDeviceReadingPostResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.NOT_SUPPORTED)))
		}
		return answered(ConsoleDeviceReadingPostResult.Ok)
	}

	override suspend fun putThreshold(gatewayId: String, put: ConsoleOp.SensorThresholdPut): DeviceAnswer<ConsoleDeviceSensorThresholdPutResult> {
		trip()
		val plugs = plugs(gatewayId)
		if (plugs.records[put.id]?.kind != Protocol.Wire.DeviceKind.SENSOR) {
			return answered(ConsoleDeviceSensorThresholdPutResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.NOT_FOUND)))
		}
		val key = put.id to put.measure
		val held = plugs.thresholds[key]
		if ((held?.revision ?: 0L) != put.revision) {
			return answered(ConsoleDeviceSensorThresholdPutResult.Refused(refusal(Protocol.Wire.DeviceRefusalCode.STALE)))
		}
		if (put.low == null && put.high == null) {
			plugs.thresholds.remove(key)
			return answered(ConsoleDeviceSensorThresholdPutResult.Ok(null))
		}
		val stored = DeviceSensorThreshold(
			measure = put.measure,
			low = put.low,
			high = put.high,
			deadZone = put.deadZone,
			coolDownSec = put.coolDownSec,
			revision = put.revision + 1,
		)
		plugs.thresholds[key] = stored
		return answered(ConsoleDeviceSensorThresholdPutResult.Ok(stored))
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
