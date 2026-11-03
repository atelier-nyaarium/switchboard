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

		/** The phone's scan; null without location. */
		var scan: List<HeardNetwork>? = null

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
							"""{"netif":{"get_scaninfo":{"ap_list":[{"ssid":"Far","key_type":3},{"ssid":"Home","key_type":3},{"ssid":"","key_type":0}],"err_code":0}}}"""
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

		override fun heard() = scan
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

		override fun pairedName(gatewayId: String, mac: String): String? = "On-Air Sign".takeIf { paired }

		var network: String? = null

		override suspend fun homeNetwork(gatewayId: String): String? = network
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
		assertEquals(listOf("Far", "Home"), ready.homes.map { it.ssid })
		assertNull(ready.signals)
		assertEquals("Home", ready.home?.ssid)
		assertEquals("", ready.name)
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
	fun `a plug already paired keeps its paired name and is re-matched rather than added again`() = runBlocking {
		val plug = FakePlug()
		val gateway = FakeGateway(plug, paired = true)
		val setup = ops(plug, gateway)

		setup.start("sakura", prefix)
		val ready = setup.view.value!!
		setup.hand("Sign", "right", null)

		assertEquals("On-Air Sign", ready.name)
		assertEquals(SetupStage.DONE, setup.view.value?.stage)
		assertTrue(gateway.added.isEmpty())
	}

	@Test
	fun `with location, the plug's networks list strongest first by the phone's own signal, in three bars`() = runBlocking {
		val plug = FakePlug().apply {
			scan = listOf(
				HeardNetwork("Home", 2437, -50, ageMs = 1_000),
				HeardNetwork("Home", 5180, -30, ageMs = 1_000),
				HeardNetwork("Far", 2412, -85, ageMs = 1_000),
				HeardNetwork("Far", 2462, -75, ageMs = 1_000),
				HeardNetwork("Far", 2437, -40, ageMs = 600_000),
				HeardNetwork("Elsewhere", 2412, -40, ageMs = 1_000),
			)
		}
		val setup = ops(plug, FakeGateway(plug))

		setup.start("sakura", prefix)
		val ready = setup.view.value!!

		assertEquals(mapOf("Home" to -50, "Far" to -75), ready.signals)
		assertEquals(
			listOf(HomeRow(HomeNetwork("Home", 3), picked = true, bars = 3), HomeRow(HomeNetwork("Far", 3), picked = false, bars = 1)),
			homeRows(ready),
		)
		assertEquals(WifiLine.Picked("Home", 3), wifiLine(ready, open = false))
		assertEquals(listOf(3, 2, 1, null), listOf(-55, -70, -90, null).map(::signalBars))
		assertEquals("", setupName(PlugFacts("aa", "HS103(US)", "TP-LINK_Smart Plug_2B0B"), null, prefix))
		assertEquals("Lamp", setupName(PlugFacts("aa", "HS103(US)", "Lamp"), null, prefix))
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
		val homes = listOf(HomeNetwork("Home", 3), HomeNetwork("Far", 3))
		assertNull(phoneSignals(homes, emptyList()))
		assertNull(phoneSignals(homes, listOf(HeardNetwork("Elsewhere", 2412, -40, ageMs = 0))))
		assertEquals(
			listOf(null, null),
			homeRows(SetupRun("sakura", prefix, SetupStage.READY, homes = homes, home = homes[0])).map { it.bars },
		)
		assertNull(preferredHome(homes, "Gone"))
		assertNull(preferredHome(homes, null))
		assertEquals("Gateway", yourWifi("Gateway", SetupMemory(ssid = "Last")))
		assertEquals("Last", yourWifi(null, SetupMemory(ssid = "Last")))
	}

	@Test
	fun `the Gateway's own network is your WiFi, over the one the last setup used`() = runBlocking {
		val plug = FakePlug().apply { stored = SetupMemory(ssid = "Far") }
		val gateway = FakeGateway(plug).apply { network = "Home" }
		val setup = ops(plug, gateway)

		setup.start("sakura", prefix)
		val ready = setup.view.value!!

		assertEquals("Home", ready.yours)
		assertEquals("Home", ready.home?.ssid)
	}

	@Test
	fun `a first setup offers no WiFi until the owner picks one`() = runBlocking {
		val plug = FakePlug().apply { stored = SetupMemory() }
		val setup = ops(plug, FakeGateway(plug))

		setup.start("sakura", prefix)
		val ready = setup.view.value!!
		setup.hand("Sign", "right", null)
		val unpicked = setup.view.value!!
		setup.pickHome(ready.homes.first { it.ssid == "Home" })
		setup.hand("Sign", "right", null)

		assertNull(ready.home)
		assertEquals(SetupStage.READY, unpicked.stage)
		assertEquals(SetupStage.DONE, setup.view.value?.stage)
		assertEquals("Home", plug.stored.ssid)
	}

	@Test
	fun `the list stays open until a pick, and Set up waits for a name, a network and a password or vault entry`() = runBlocking {
		val plug = FakePlug().apply { stored = SetupMemory(ssid = "Gone") }
		val setup = ops(plug, FakeGateway(plug))

		setup.start("sakura", prefix)
		val unpicked = setup.view.value!!
		setup.pickHome(unpicked.homes.first { it.ssid == "Far" })
		val picked = setup.view.value!!

		assertEquals(true to WifiLine.Unseen("Gone"), wifiListOpen(unpicked, changing = false) to wifiLine(unpicked, open = true))
		assertEquals(false to WifiLine.Picked("Far", null), wifiListOpen(picked, changing = false) to wifiLine(picked, open = false))
		assertEquals(WifiLine.Blank, wifiLine(picked, open = wifiListOpen(picked, changing = true)))
		assertEquals(false, setupReady(unpicked, "Sign", PasswordSource.TYPED, "pw", null))
		assertEquals(false, setupReady(picked, " ", PasswordSource.TYPED, "pw", null))
		assertEquals(false, setupReady(picked, "Sign", PasswordSource.TYPED, "", "wifi-key"))
		assertEquals(false, setupReady(picked, "Sign", PasswordSource.VAULT, "pw", null))
		assertEquals(true, setupReady(picked, "Sign", PasswordSource.TYPED, "pw", null))
		assertEquals(true, setupReady(picked, "Sign", PasswordSource.VAULT, "", "wifi-key"))
		assertEquals(PasswordSource.VAULT, defaultSource(SetupMemory(wifiEntry = "wifi-key")))
		assertEquals(PasswordSource.TYPED, defaultSource(SetupMemory()))
	}
}
