package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadingPostResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceScanResult
import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceNearby
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val THERMO = "02:00:00:00:00:21"
private const val RAW = "02:00:00:00:00:22"
private const val LIGHT = "02:00:00:00:00:23"

private val tested = Advert("GVH5110_3C5D", mapOf("1" to "010103bac864"), listOf("ec88"))
private val untested = Advert("Govee_H5199_7F01", mapOf("1" to "0101027a3f550000"), listOf("ec88"))
private val stranger = Advert("Kettle", mapOf("76" to "0102"), emptyList())
private val hub = Advert("Govee_H5151_4E42", mapOf("34817" to "ec000101"), emptyList())

private val named = Advert("GVH5110_3C5D", emptyMap(), listOf("ec88"))
private val reading = Advert(null, mapOf("1" to "010103bac864"), emptyList())
private val beacon = Advert(null, mapOf("76" to "0215494e54454c4c495f524f434b535f4857"), emptyList())

private fun heardOf(gateways: Map<String, List<Sighting>>, phone: List<Sighting> = emptyList()): Heard =
	gateways.entries.fold(Heard()) { heard, (gatewayId, sightings) -> heard.with(gatewayId, sightings) }.with(null, phone)

private fun found(gateways: Map<String, List<Sighting>>, phone: List<Sighting> = emptyList(), paired: Set<String> = emptySet()) =
	foundDevices("govee", heardOf(gateways, phone), paired) { definitionHit("govee", it) }

class PairRulesTest {
	@Test
	fun `every radio's sightings merge by address in first-heard order, family only and unpaired`() {
		val heard = heardOf(
			gateways = mapOf(
				"sakura" to listOf(Sighting(THERMO, -61, tested), Sighting(RAW, -73, untested), Sighting(LIGHT, -40, stranger)),
				"mikan" to listOf(Sighting(THERMO, -84, tested)),
			),
			phone = listOf(Sighting(RAW, -58, untested)),
		)
		val rows = foundDevices("govee", heard, emptySet()) { definitionHit("govee", it) }
		assertEquals(listOf(THERMO, RAW), rows.map { it.mac })
		val louder = foundDevices("govee", heard.with(null, listOf(Sighting(RAW, -30, untested))), emptySet()) { definitionHit("govee", it) }
		assertEquals(listOf(THERMO, RAW), louder.map { it.mac })
		assertEquals(-30, louder.single { it.mac == RAW }.strongest)
		assertEquals(DefinitionHit("govee-h5110", "H5110"), rows.single { it.mac == THERMO }.definition)
		assertEquals("Not tested · raw only", testedLine(rows.single { it.mac == RAW }))
		assertNull(testedLine(rows.single { it.mac == THERMO }))
		val listed = found(mapOf("sakura" to listOf(Sighting(LIGHT, -50, hub))), phone = listOf(Sighting(THERMO, -50, tested)))
		assertEquals(listOf(false, true), listed.map { it.supported })
		assertNull(testedLine(listed.first()))
		assertEquals(emptyList<FoundDevice>(), found(mapOf("sakura" to listOf(Sighting(THERMO, -61, tested))), paired = setOf(THERMO)))
	}

	@Test
	fun `a device splitting its markers across packets is recognized only as their union`() {
		assertEquals(emptyList<FoundDevice>(), found(emptyMap(), phone = listOf(Sighting(THERMO, -50, reading))))
		val row = found(emptyMap(), phone = listOf(named, reading, beacon).map { Sighting(THERMO, -50, it) }).single()
		assertEquals(DefinitionHit("govee-h5110", "H5110"), row.definition)
		assertEquals(listOf(THIS_PHONE), pairChoices(row, home = "sakura").map { it.label })
	}

	@Test
	fun `Pair with lists home first, then other Gateways, then This Phone, whatever their signal`() {
		val device = found(
			gateways = mapOf("sakura" to listOf(Sighting(THERMO, -61, tested)), "mikan" to listOf(Sighting(THERMO, -84, tested))),
			phone = listOf(Sighting(THERMO, -50, tested)),
		).single()
		val choices = pairChoices(device, home = "mikan")
		assertEquals(listOf("mikan" to true, "sakura" to false, THIS_PHONE to true), choices.map { it.label to it.assistant })
		assertEquals(listOf(-84, -61, -50), choices.map { it.signal })
		val (onPhone, viaPhone) = pairingOf(device, choices.last(), home = "mikan")
		assertEquals("mikan" to Protocol.Wire.DeviceRadio.PHONES, onPhone to viaPhone.radio)
		assertEquals(advertOf(tested), viaPhone.advert)
		val (onSakura, viaSakura) = pairingOf(device, choices[1], home = "mikan")
		assertEquals("sakura" to Protocol.Wire.DeviceRadio.GATEWAY, onSakura to viaSakura.radio)
		assertNull(viaSakura.advert)
		val roster = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(
				GatewayEntry("sakura", connected = true, incarnation = 1L, lastRegisteredAt = 0L),
				GatewayEntry("matrix", connected = false, incarnation = 1L, lastRegisteredAt = 0L),
			),
		)
		assertEquals(listOf("sakura"), scanTargets(roster))
	}

	@Test
	fun `a phone binding follows the Gateway whose list names it, and an unloaded roster or unread list keeps the held one`() {
		val kitchen = DeviceRecord(id = THERMO, name = "Kitchen", kind = "sensor", driver = "govee", address = THERMO, radio = "phones", revision = 1L)
		val listed = mapOf("sakura" to DevicesView(list = DeviceListView.Listed(listOf(kitchen), 1L)))
		fun roster(vararg ids: String) =
			GatewayRegistry(provenance = RegistryProvenance.Current, gateways = ids.map { GatewayEntry(it, connected = true, incarnation = 1L, lastRegisteredAt = 0L) })
		val held = mapOf(RAW to "mikan")
		assertEquals(held, bindingsAfter(held, GatewayRegistry(), emptyMap()))
		assertEquals(mapOf(THERMO to "sakura"), bindingsAfter(emptyMap(), roster("sakura"), listed))
		val unread = mapOf("mikan" to DevicesView(list = DeviceListView.Unavailable("down")))
		assertEquals(held, bindingsAfter(held, roster("mikan"), unread))
		assertEquals(emptyMap<String, String>(), bindingsAfter(held, roster("sakura"), emptyMap()))
	}

	@Test
	fun `the coalescer posts the newest capture under one hold, and a failed post lets the next sighting retry`() = runBlocking {
		val posts = mutableListOf<Triple<String, String, Long>>()
		var clock = 0L
		var holds = 0
		var releases = 0
		var answer: DeviceAnswer<ConsoleDeviceReadingPostResult> = DeviceAnswer.Answered(ConsoleDeviceReadingPostResult.Ok)
		val gateway = object : DeviceGateway by unusedGateway() {
			override suspend fun postReading(gatewayId: String, id: String, advert: DeviceAdvert, at: Long): DeviceAnswer<ConsoleDeviceReadingPostResult> {
				posts += Triple(gatewayId, id, at)
				return answer
			}
		}
		val scope = CoroutineScope(Dispatchers.Unconfined)
		val readings = BleReadings(scope, { mapOf(THERMO to "mikan", LIGHT to "mikan") }, { gateway }, { clock }, { holds += 1 }, { releases += 1 })
		val warmer = tested.copy(data = mapOf("1" to "010103bac865"))
		assertEquals(1, readings.accept(listOf(Sighting(THERMO, -60, warmer, at = 20), Sighting(THERMO, -60, tested, at = 10), Sighting(RAW, -60, untested))))
		assertEquals(0, readings.accept(listOf(Sighting(THERMO, -55, warmer), Sighting(LIGHT, -40, stranger))))
		answer = DeviceAnswer.Unreachable
		clock = REPOST_MS + 20
		assertEquals(1, readings.accept(listOf(Sighting(THERMO, -55, warmer))))
		clock += 1_000
		assertEquals(1, readings.accept(listOf(Sighting(THERMO, -55, warmer))))
		assertEquals(listOf(20L, REPOST_MS + 20, REPOST_MS + 1_020), posts.map { it.third })
		assertEquals(3 to 3, holds to releases)
	}

	@Test
	fun `split packets post their union, so a lone beacon never posts a reading without its data`() = runBlocking {
		val posts = mutableListOf<DeviceAdvert>()
		val gateway = object : DeviceGateway by unusedGateway() {
			override suspend fun postReading(gatewayId: String, id: String, advert: DeviceAdvert, at: Long): DeviceAnswer<ConsoleDeviceReadingPostResult> {
				posts += advert
				return DeviceAnswer.Answered(ConsoleDeviceReadingPostResult.Ok)
			}
		}
		val readings = BleReadings(CoroutineScope(Dispatchers.Unconfined), { mapOf(THERMO to "mikan") }, { gateway }, { 0L })
		assertEquals(0, readings.accept(listOf(Sighting(THERMO, -60, reading, at = 1))))
		assertEquals(1, readings.accept(listOf(Sighting(THERMO, -60, named, at = 2))))
		assertEquals(1, readings.accept(listOf(Sighting(THERMO, -60, beacon, at = 3))))
		assertEquals(0, readings.accept(listOf(Sighting(THERMO, -60, beacon, at = 4))))
		assertEquals(listOf(unionAdvert(reading, named), listOf(reading, named, beacon).reduce(::unionAdvert)).map(::advertOf), posts)
	}

	@Test
	fun `one Start scan keeps every device heard across rescans, in order, and names a refused radio`() = runBlocking {
		val refusing = object : BlePlatform {
			override fun readiness() = RadioReadiness.READY

			override suspend fun listen(heard: (Sighting) -> Unit) = throw BleScanFailed(2)

			override fun watch(addresses: Set<String>) = true
		}
		fun nearby(mac: String, advert: Advert) = DeviceNearby(
			mac = mac,
			radio = Protocol.Wire.DeviceRadio.GATEWAY,
			name = advert.name,
			signal = -60,
			data = JsonObject(advert.data.mapValues { JsonPrimitive(it.value) }),
			services = advert.services,
		)
		val answers = ArrayDeque(
			listOf<DeviceAnswer<ConsoleDeviceScanResult>>(
				DeviceAnswer.Answered(ConsoleDeviceScanResult.Ok(emptyList(), listOf(nearby(THERMO, tested)), bluetooth = true)),
				DeviceAnswer.Answered(ConsoleDeviceScanResult.Ok(emptyList(), listOf(nearby(RAW, untested)), bluetooth = true)),
				DeviceAnswer.Declined,
			),
		)
		val gateway = object : DeviceGateway by unusedGateway() {
			override suspend fun scan(gatewayId: String): DeviceAnswer<ConsoleDeviceScanResult> = answers.removeFirst()
		}
		val ops = ListenOps({ refusing }, { gateway }, pause = {})
		ops.listen(listOf("sakura"))
		val view = ops.view.value
		assertEquals(false, view.listening)
		assertEquals(listOf(THERMO, RAW), foundDevices("govee", view.heard, emptySet()) { null }.map { it.mac })
		assertTrue(view.phone != null)
		assertTrue("sakura" in view.failed)
	}
}

private fun unusedGateway(): DeviceGateway = java.lang.reflect.Proxy.newProxyInstance(
	DeviceGateway::class.java.classLoader,
	arrayOf(DeviceGateway::class.java),
) { _, method, _ -> error("unexpected ${method.name}") } as DeviceGateway
