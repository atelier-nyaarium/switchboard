package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadingPostResult
import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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

private fun found(gateways: Map<String, List<Sighting>>, phone: List<Sighting> = emptyList(), paired: Set<String> = emptySet()) =
	foundDevices("govee", gateways, phone, paired) { definitionHit("govee", it) }

class PairRulesTest {
	@Test
	fun `every radio's sightings merge by address, strongest first, family only and unpaired`() {
		val rows = found(
			gateways = mapOf(
				"sakura" to listOf(Sighting(THERMO, -61, tested), Sighting(RAW, -73, untested), Sighting(LIGHT, -40, stranger)),
				"mikan" to listOf(Sighting(THERMO, -84, tested)),
			),
			phone = listOf(Sighting(RAW, -58, untested)),
		)
		assertEquals(listOf(RAW, THERMO), rows.map { it.mac })
		assertEquals(DefinitionHit("govee-h5110", "H5110"), rows.single { it.mac == THERMO }.definition)
		assertEquals("Not tested · raw only", testedLine(rows.single { it.mac == RAW }))
		assertNull(testedLine(rows.single { it.mac == THERMO }))
		assertEquals(emptyList<FoundDevice>(), found(mapOf("sakura" to listOf(Sighting(THERMO, -61, tested))), paired = setOf(THERMO)))
	}

	@Test
	fun `Pair with lists the Gateways that heard it strongest first, then This Phone, marking what the assistant sees`() {
		val device = found(
			gateways = mapOf("mikan" to listOf(Sighting(THERMO, -84, tested)), "sakura" to listOf(Sighting(THERMO, -61, tested))),
			phone = listOf(Sighting(THERMO, -50, tested)),
		).single()
		val choices = pairChoices(device, home = "sakura")
		assertEquals(listOf("sakura" to true, "mikan" to false, THIS_PHONE to true), choices.map { it.label to it.assistant })
		val (onPhone, viaPhone) = pairingOf(device, choices.last(), home = "sakura")
		assertEquals("sakura" to Protocol.Wire.DeviceRadio.PHONES, onPhone to viaPhone.radio)
		assertEquals(advertOf(tested), viaPhone.advert)
		val (onMikan, viaMikan) = pairingOf(device, choices[1], home = "sakura")
		assertEquals("mikan" to Protocol.Wire.DeviceRadio.GATEWAY, onMikan to viaMikan.radio)
		assertNull(viaMikan.advert)
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
	fun `a scan the radio refuses reads as failed, not as nothing heard`() = runBlocking {
		val refusing = object : BlePlatform {
			override fun readiness() = RadioReadiness.READY

			override suspend fun scan(windowMs: Long): List<Sighting> = throw BleScanFailed(2)

			override fun watch(addresses: Set<String>) = true
		}
		val ops = PhoneScanOps { refusing }
		ops.scan()
		assertTrue(ops.view.value is PhoneScanView.Failed)
	}
}

private fun unusedGateway(): DeviceGateway = java.lang.reflect.Proxy.newProxyInstance(
	DeviceGateway::class.java.classLoader,
	arrayOf(DeviceGateway::class.java),
) { _, method, _ -> error("unexpected ${method.name}") } as DeviceGateway
