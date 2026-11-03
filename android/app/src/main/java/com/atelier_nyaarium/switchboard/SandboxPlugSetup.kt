package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import kotlinx.coroutines.delay

/** The emulator's plug in setup mode; the first password it is handed is wrong. */
internal class SandboxPlugSetup : PlugSetupPlatform {
	private var memory = SetupMemory()
	private var handed = 0
	private var joining = false
	private var alias = ""

	/** On the network once a hand-off took. */
	fun joined(): DeviceCandidate? = if (!joining) null else DeviceCandidate(
		mac = SETUP_MAC,
		address = "192.0.2.20",
		alias = alias,
		model = "HS103(US)",
		hardware = "3.0",
		firmware = "1.0.3",
	)

	override suspend fun join(networkPrefix: String): PlugLink? {
		delay(600)
		if (joining) return null
		return object : PlugLink {
			override suspend fun request(json: String): String {
				delay(200)
				return when {
					json.contains("get_sysinfo") ->
						"""{"system":{"get_sysinfo":{"mac":"AA:BB:CC:DD:EE:20","model":"HS103(US)","alias":"","err_code":0}}}"""
					json.contains("get_scaninfo") ->
						"""{"netif":{"get_scaninfo":{"ap_list":[{"ssid":"Neighbor","key_type":3},{"ssid":"Sandbox Home","key_type":3}],"err_code":0}}}"""
					json.contains("set_stainfo") -> {
						handed += 1
						// The first hand-off does not take.
						joining = handed >= 2
						"""{"netif":{"set_stainfo":{"err_code":0}}}"""
					}
					else -> {
						alias = Regex("\"alias\":\"([^\"]*)\"").find(json)?.groupValues?.get(1).orEmpty()
						"""{"system":{"set_dev_alias":{"err_code":0}}}"""
					}
				}
			}

			override fun close() = Unit
		}
	}

	override fun memory(): SetupMemory = memory

	override fun remember(memory: SetupMemory) {
		this.memory = memory
	}

	override fun heard(): List<HeardNetwork> = listOf(
		HeardNetwork("Sandbox Home", 2437, -48, ageMs = 2_000),
		HeardNetwork("Sandbox Home", 5180, -40, ageMs = 2_000),
		HeardNetwork("Neighbor", 2412, -78, ageMs = 2_000),
	)

	companion object {
		const val SETUP_MAC = "aa:bb:cc:dd:ee:20"
	}
}
