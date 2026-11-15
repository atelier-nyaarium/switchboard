package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.DeviceReading
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSensorPayload
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private const val MAC = "02:00:00:00:00:11"
private const val HOUR = 3_600_000L

private val temperature = AssistantFieldSpec.Number(field = "temperature", label = "Temperature", unit = "C", decimals = 1)
private val humidity = AssistantFieldSpec.Number(field = "humidity", label = "Humidity", unit = "%", decimals = 1)

private fun read(stale: String? = null) = ConsoleDeviceReadResult.Sensor(
	readings = listOf(
		DeviceReading(spec = temperature, value = JsonPrimitive(-18.2)),
		DeviceReading(spec = humidity, value = JsonPrimitive(61.2)),
	),
	heardAt = 0L,
	stale = stale,
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
	fun `groups put home first and show only Gateways listing a device, with one spinner until any answers`() {
		val lamp = DeviceListView.Listed(listOf(sensor(MAC, "gateway")), 1L)
		val views = mapOf(
			"mikan" to DevicesView(list = lamp),
			"sakura" to DevicesView(list = lamp),
			"idle" to DevicesView(list = DeviceListView.Listed(emptyList(), 1L)),
			"old" to DevicesView(list = DeviceListView.Declined),
			"away" to DevicesView(list = DeviceListView.Unavailable("This Gateway could not be reached")),
		)
		val roster = listOf("mikan", "idle", "old", "away", "waking", "sakura")
		val groups = deviceGroups(roster, home = "sakura", views)
		assertEquals(listOf("sakura" to true, "mikan" to false), groups.map { it.gatewayId to it.assistant })
		// Session Gateway leads.
		assertEquals(
			listOf("mikan", "sakura"),
			sourceGroups(roster, "sakura", views, hasServices = true, lead = "mikan").map { it.gatewayId },
		)
		val servicesOnly = sourceGroups(roster, "idle", views, hasServices = true, lead = "mikan")
		assertEquals(listOf("mikan" to false, "idle" to true, "sakura" to false), servicesOnly.map { it.gatewayId to it.assistant })
		assertEquals(emptyList<Any>(), servicesOnly.first { it.assistant }.records)
		assertEquals(listOf("mikan", "sakura"), sourceGroups(roster, "idle", views, hasServices = false, lead = null).map { it.gatewayId })
		assertEquals(false, devicesPending(roster, views))
		assertEquals(true, devicesPending(listOf("sakura", "waking"), mapOf("sakura" to DevicesView(list = DeviceListView.Loading))))
		val word = { held: AssistantWord? ->
			val entry = GatewayEntry("sakura", connected = true, incarnation = 1L, lastRegisteredAt = 1L, assistant = held)
			servicesWaiting(GatewayRegistry(RegistryProvenance.Current, gateways = listOf(entry)).assistantRead("sakura"))
		}
		val answered = AssistantWord.Answered(com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult(workdir = "~/notes"))
		assertEquals(listOf("", null, false), listOf(word(null), word(answered), word(AssistantWord.Refused).isNullOrEmpty()))
		assertEquals("Govee · This Phone", rowBrandLine(sensor(MAC, "phones")))
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
