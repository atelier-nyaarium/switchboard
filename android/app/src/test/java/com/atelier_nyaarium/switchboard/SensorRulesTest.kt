package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.DeviceReading
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSensorPayload
import com.atelier_nyaarium.switchboard.proto.DeviceSensorThreshold
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val MAC = "02:00:00:00:00:11"
private const val HOUR = 3_600_000L

private val temperature = AssistantFieldSpec.Number(field = "temperature", label = "Temperature", unit = "C", decimals = 1)
private val humidity = AssistantFieldSpec.Number(field = "humidity", label = "Humidity", unit = "%", decimals = 1)

private fun read(stale: String? = null, vararg thresholds: DeviceSensorThreshold) = ConsoleDeviceReadResult.Sensor(
	readings = listOf(
		DeviceReading(spec = temperature, value = JsonPrimitive(-18.2), alerts = listOf("low", "high")),
		DeviceReading(spec = humidity, value = JsonPrimitive(61.2), alerts = listOf("low")),
	),
	heardAt = 0L,
	stale = stale,
	thresholds = thresholds.toList(),
)

private fun sensor(id: String, radio: String) =
	DeviceRecord(id = id, name = id, kind = "sensor", driver = "govee", address = id, radio = radio, revision = 1L)

private fun payload(hex: String, at: Long, radio: String) =
	DeviceSensorPayload(data = JsonObject(mapOf("1" to JsonPrimitive(hex))), services = emptyList(), at = at, radio = radio)

class SensorRulesTest {
	@Test
	fun `a sensor row shows its first reading in the owner's unit, greyed and explained once stale`() {
		assertEquals(MainValue("-18.2 °C", stale = false), mainValue(SensorHeld(read()), display = null))
		assertEquals(MainValue("-0.8 °F", stale = true), mainValue(SensorHeld(read(stale = "not heard")), display = "F"))
		assertNull(sensorTrouble(SensorHeld(read()), now = 2 * HOUR))
		assertEquals("Last heard 2 hours ago", sensorTrouble(SensorHeld(read(stale = "not heard")), now = 2 * HOUR))
		assertEquals("No longer paired", sensorTrouble(SensorHeld(failed = "No longer paired"), now = 0L))
		val unreachable = SensorHeld(read(), failed = "This Gateway could not be reached")
		assertEquals(MainValue("-18.2 °C", stale = true), mainValue(unreachable, display = null))
		assertEquals("This Gateway could not be reached", sensorTrouble(unreachable, now = 0L))
		val kitchen = sensor(MAC, "phones")
		assertEquals("Govee H5110 · sakura · This Phone · 2 hours ago", sensorSubtitle(kitchen, "H5110", "sakura", SensorHeld(read()), now = 2 * HOUR))
		assertEquals("Govee H5110 · sakura · This Phone", sensorSubtitle(kitchen, "H5110", "sakura", SensorHeld(read(stale = "not heard")), now = 2 * HOUR))
	}

	@Test
	fun `groups put home first and hide a Gateway that declines or holds nothing`() {
		val lamp = DeviceListView.Listed(listOf(sensor(MAC, "gateway")), 1L)
		val views = mapOf(
			"mikan" to DevicesView(list = lamp),
			"sakura" to DevicesView(list = lamp),
			"idle" to DevicesView(list = DeviceListView.Listed(emptyList(), 1L)),
			"old" to DevicesView(list = DeviceListView.Declined),
		)
		val groups = deviceGroups(listOf("mikan", "idle", "old", "sakura"), home = "sakura", views)
		assertEquals(listOf("sakura" to true, "mikan" to false), groups.map { it.gatewayId to it.assistant })
		assertEquals("Govee · This Phone", rowBrandLine(sensor(MAC, "phones")))
	}

	@Test
	fun `an alert typed in Fahrenheit is stored in Celsius and read back as typed`() {
		val held = DeviceSensorThreshold(measure = "temperature", high = -12.2, deadZone = 1.1, coolDownSec = 30, revision = 4)
		val blocks = alertBlocks(read(null, held), display = "F")
		val low = blocks.first().rows.first { it.side == AlertSide.LOW }
		assertEquals(listOf("Temperature below", "Temperature above"), blocks.first().rows.map { it.label })
		assertEquals("Humidity below", blocks[1].rows.single().label)
		assertEquals("10.0" to " °F", blocks.first().rows.first { it.side == AlertSide.HIGH }.let { it.value to it.suffix })
		assertEquals("2.0 °F", blocks.first().deadZone)
		val edit = sideEdit(MAC, read(null, held), low, "-20", display = "F") as ThresholdEdit.Put
		assertEquals(-28.89, edit.put.low)
		assertEquals(-12.2, edit.put.high)
		assertEquals(4L, edit.put.revision)
		assertEquals(30L, edit.put.coolDownSec)
		assertEquals(ThresholdEdit.Issue("Below must be under above"), sideEdit(MAC, read(null, held), low, "15", display = "F"))
		assertEquals(ThresholdEdit.Issue("Not a number"), sideEdit(MAC, read(null, held), low, "cold", display = "F"))
		val near = DeviceSensorThreshold(measure = "temperature", low = 10.0, deadZone = 1.0, coolDownSec = 0, revision = 1)
		val nearHigh = alertBlocks(read(null, near), display = null).first().rows.first { it.side == AlertSide.HIGH }
		assertEquals(ThresholdEdit.Issue(TOO_NARROW), sideEdit(MAC, read(null, near), nearHigh, "11", display = null))
		val wide = near.copy(high = 20.0)
		assertEquals(ThresholdEdit.Issue(TOO_NARROW), deadZoneEdit(MAC, read(null, wide), "temperature", "5", display = null))
	}

	@Test
	fun `a switch turned off clears one side, and the dead zone is a width`() {
		val held = DeviceSensorThreshold(measure = "temperature", low = -28.9, high = -12.2, deadZone = 1.1, coolDownSec = 0, revision = 2)
		val high = alertBlocks(read(null, held), display = null).first().rows.first { it.side == AlertSide.HIGH }
		val cleared = sideCleared(MAC, read(null, held), high)
		assertEquals(-28.9, cleared?.low)
		assertNull(cleared?.high)
		val widened = deadZoneEdit(MAC, read(null, held), "temperature", "3.6", display = "F") as ThresholdEdit.Put
		assertEquals(2.0, widened.put.deadZone, 0.0)
		assertEquals(ThresholdEdit.Issue("Set an alert first"), deadZoneEdit(MAC, read(), "temperature", "1", display = null))
	}

	@Test
	fun `the raw view marks bytes that moved since the older payload`() {
		val view = payloadView(
			listOf(payload("0102037a", 30L, "gateway"), payload("01020379", 20L, "phones"), payload("01020379", 10L, "gateway")),
			gatewayId = "sakura",
		)
		assertEquals("0x0001", view?.company)
		assertEquals(listOf("sakura", THIS_PHONE, "sakura"), view?.rows?.map { it.radio })
		assertEquals(listOf(false, false, false, true), view?.rows?.first()?.changed)
		assertEquals(listOf(false, false, false, false), view?.rows?.get(1)?.changed)
	}
}
