package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlugSetupOpsTest {
	private val prefix = "TP-LINK_Smart Plug_"

	/** A plug that joins only with `goodPassword`, and stays in setup mode otherwise. */
	private class FakePlug(var goodPassword: String = "right", var mac: String = "84:D8:1B:00:2B:0B") : PlugSetupPlatform {
		val sent = mutableListOf<String>()
		var joins = 0
		var declines = false
		var stored = SetupMemory(ssid = "Home", wifiEntry = "wifi-key")
		var onNetwork = false

		override suspend fun join(networkPrefix: String): PlugLink? {
			joins += 1
			if (declines || onNetwork) return null
			return object : PlugLink {
				override suspend fun request(json: String): String {
					sent += json
					return when {
						json.contains("get_sysinfo") ->
							"""{"system":{"get_sysinfo":{"mac":"$mac","model":"HS103(US)","alias":"","err_code":0}}}"""
						json.contains("get_scaninfo") ->
							"""{"netif":{"get_scaninfo":{"ap_list":[{"ssid":"Far","key_type":3,"rssi":-85},{"ssid":"Home","key_type":3,"rssi":-50},{"ssid":"","key_type":0,"rssi":-30}],"err_code":0}}}"""
						json.contains("set_stainfo") -> {
							onNetwork = json.contains("\"password\":\"$goodPassword\"")
							"""{"netif":{"set_stainfo":{"err_code":0}}}"""
						}
						else -> """{"system":{"set_dev_alias":{"err_code":0}}}"""
					}
				}

				override fun close() = Unit
			}
		}

		override fun memory() = stored

		override fun remember(memory: SetupMemory) {
			stored = memory
		}
	}

	private class FakeGateway(private val plug: FakePlug, private var paired: Boolean = false) : SetupGateway {
		val added = mutableListOf<Pair<String, String>>()
		var refuseAdd = false

		override suspend fun scan(gatewayId: String) = Unit

		override fun found(gatewayId: String, mac: String): FoundPlug? = when {
			paired -> FoundPlug.PAIRED
			plug.onNetwork -> FoundPlug.CANDIDATE
			else -> null
		}

		override suspend fun add(gatewayId: String, mac: String, name: String): Boolean {
			if (refuseAdd) return false
			added += mac to name
			paired = true
			return true
		}
	}

	private fun ops(plug: FakePlug, gateway: SetupGateway) = PlugSetupOps(plug, gateway, waitMs = 5L, gatewayEveryMs = 1L)

	@Test
	fun `a fresh plug is read on its own network, handed the home WiFi, and added once it answers the Gateway`() = runBlocking {
		val plug = FakePlug()
		val gateway = FakeGateway(plug)
		val setup = ops(plug, gateway)

		setup.start("sakura", prefix)
		val ready = setup.view.value!!
		setup.hand("On-Air Sign", "right", "wifi-key")
		val done = setup.view.value!!

		assertEquals(SetupStage.READY, ready.stage)
		assertEquals("84:d8:1b:00:2b:0b", ready.plug?.mac)
		assertEquals(listOf("Home", "Far"), ready.homes.map { it.ssid })
		assertEquals("Home", ready.home?.ssid)
		assertEquals("HS103(US)", ready.name)
		assertEquals(SetupStage.DONE, done.stage)
		assertEquals("84:d8:1b:00:2b:0b", done.deviceId)
		assertEquals(listOf("84:d8:1b:00:2b:0b" to "On-Air Sign"), gateway.added)
		assertTrue(plug.sent.any { it.contains("\"alias\":\"On-Air Sign\"") })
		assertTrue(plug.sent.any { it.contains("\"ssid\":\"Home\"") && it.contains("\"key_type\":3") })
		assertEquals(SetupMemory(ssid = "Home", wifiEntry = "wifi-key"), plug.stored)
	}

	@Test
	fun `a plug that never joins asks for the password, and a typed one rejoins the same plug and adds it`() = runBlocking {
		val plug = FakePlug()
		val gateway = FakeGateway(plug)
		val setup = ops(plug, gateway)

		setup.start("sakura", prefix)
		setup.hand("Sign", "wrong", "wifi-key")
		val asked = setup.view.value!!
		setup.hand("Sign", "right", null)

		assertEquals(SetupStage.ASK_PASSWORD, asked.stage)
		assertEquals(PlugSetupOps.NOT_SEEN, asked.said)
		assertEquals(2, plug.joins)
		assertEquals(SetupStage.DONE, setup.view.value?.stage)
		assertEquals("wifi-key", plug.stored.wifiEntry)
	}

	@Test
	fun `a retry that picks a different plug hands it nothing`() = runBlocking {
		val plug = FakePlug()
		val setup = ops(plug, FakeGateway(plug))

		setup.start("sakura", prefix)
		setup.hand("Sign", "wrong", null)
		plug.mac = "84:D8:1B:00:99:99"
		val before = plug.sent.count { it.contains("set_stainfo") }
		setup.hand("Sign", "right", null)

		assertEquals(PlugSetupOps.OTHER_PLUG, setup.view.value?.said)
		assertEquals(before, plug.sent.count { it.contains("set_stainfo") })
	}

	@Test
	fun `a plug already paired is re-matched rather than added again`() = runBlocking {
		val plug = FakePlug()
		val gateway = FakeGateway(plug, paired = true)
		val setup = ops(plug, gateway)

		setup.start("sakura", prefix)
		setup.hand("Sign", "right", null)

		assertEquals(SetupStage.DONE, setup.view.value?.stage)
		assertTrue(gateway.added.isEmpty())
	}

	@Test
	fun `a declined join and a refused add each say why, and cancel ends the run`() = runBlocking {
		val declined = FakePlug().apply { declines = true }
		val refusedJoin = ops(declined, FakeGateway(declined))
		refusedJoin.start("sakura", prefix)
		assertEquals(PlugSetupOps.NOT_JOINED, refusedJoin.view.value?.said)

		val joins = FakePlug()
		val adding = ops(joins, FakeGateway(joins).apply { refuseAdd = true })
		adding.start("sakura", prefix)
		adding.hand("Sign", "right", null)
		assertEquals(PlugSetupOps.NOT_ADDED, adding.view.value?.said)

		adding.cancel()
		assertNull(adding.view.value)
	}

	@Test
	fun `answers parse, an err_code refuses, and the vault value wins over asking`() = runBlocking {
		assertNull(plugFactsOf("""{"system":{"get_sysinfo":{"err_code":-1}}}"""))
		assertNull(plugFactsOf("not json"))
		assertEquals(emptyList<HomeNetwork>(), homeNetworksOf("""{"netif":{"get_scaninfo":{"err_code":-2}}}"""))
		assertEquals("vault", setupPassword("wifi-key") { "vault" })
		assertNull(setupPassword("wifi-key") { null })
		assertNull(setupPassword(null) { "unused" })
		assertEquals(
			HomeNetwork("Home", 3, -40),
			preferredHome(listOf(HomeNetwork("Home", 3, -40), HomeNetwork("Far", 3, -80)), SetupMemory(ssid = "Gone")),
		)
	}
}
