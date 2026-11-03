package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The phone's reach to a device's own setup network. */
internal interface PlugSetupPlatform {
	/** The system picker lists matching networks; null when the owner declined or none came up. */
	suspend fun join(networkPrefix: String): PlugLink?

	fun memory(): SetupMemory

	fun remember(memory: SetupMemory)
}

/** One plug's setup network, held until closed. */
internal interface PlugLink : AutoCloseable {
	/** Throws when the plug does not answer. */
	suspend fun request(json: String): String

	override fun close()
}

/** What setup asks of the Gateway: scan, then add. */
internal interface SetupGateway {
	suspend fun scan(gatewayId: String)

	fun found(gatewayId: String, mac: String): FoundPlug?

	suspend fun add(gatewayId: String, mac: String, name: String): Boolean

	fun pairedName(gatewayId: String, mac: String): String?
}

internal enum class FoundPlug { PAIRED, CANDIDATE }

/** Setup's Gateway half, through the device ops and their view. */
internal class DeviceSetupGateway(private val devices: DeviceOps) : SetupGateway {
	override suspend fun scan(gatewayId: String) = devices.scan(gatewayId)

	override fun found(gatewayId: String, mac: String): FoundPlug? {
		val view = devices.view(gatewayId)
		if (view.paired(mac)) return FoundPlug.PAIRED
		return if ((view.scan as? ScanView.Found)?.candidates?.any { it.mac == mac } == true) FoundPlug.CANDIDATE else null
	}

	override suspend fun add(gatewayId: String, mac: String, name: String): Boolean {
		val candidate = (devices.view(gatewayId).scan as? ScanView.Found)?.candidates?.find { it.mac == mac } ?: return false
		return devices.add(gatewayId, candidate, name) is DeviceSaved.Stored
	}

	override fun pairedName(gatewayId: String, mac: String): String? = deviceRecord(devices.view(gatewayId), mac)?.name
}

internal class PlugSetupOps(
	private val platform: PlugSetupPlatform,
	private val gateway: SetupGateway,
	private val waitMs: Long = SETUP_WAIT_MS,
	private val gatewayEveryMs: Long = 8_000L,
) {
	private val state = MutableStateFlow<SetupRun?>(null)

	val view: StateFlow<SetupRun?> = state

	private val runs = Mutex()

	private var link: PlugLink? = null

	/** Bumped by cancel, so a run it ended lands nothing. */
	@Volatile private var generation = 0L

	fun memory(): SetupMemory = platform.memory()

	/** Joins a plug's setup network through the picker and reads it. */
	suspend fun start(gatewayId: String, networkPrefix: String) = runs.withLock {
		closeLink()
		val began = ++generation
		state.value = SetupRun(gatewayId, networkPrefix, SetupStage.JOINING)
		val joined = platform.join(networkPrefix)
		if (joined == null) return@withLock settle(began) { it.copy(stage = SetupStage.FAILED, said = NOT_JOINED) }
		link = joined
		val plug = runCatchingCancellable { joined.request(KasaSetupCommands.SYSINFO) }.getOrNull()?.let(::plugFactsOf)
		if (plug == null) return@withLock settle(began) { it.copy(stage = SetupStage.FAILED, said = NOT_READ) }
		val homes = scanHomes(joined)
		settle(began) {
			it.copy(
				stage = SetupStage.READY,
				plug = plug,
				homes = homes,
				home = preferredHome(homes, platform.memory()),
				name = setupName(plug, gateway.pairedName(gatewayId, plug.mac), networkPrefix),
			)
		}
	}

	/** The onboarding scan carries signal; the netif one is the fallback. */
	private suspend fun scanHomes(joined: PlugLink): List<HomeNetwork> {
		val onboarding = runCatchingCancellable { joined.request(KasaSetupCommands.ONBOARDING_SCAN) }.getOrNull()
			?.let { homeNetworksOf(it, KasaSetupCommands.ONBOARDING) }.orEmpty()
		if (onboarding.isNotEmpty()) return onboarding
		return runCatchingCancellable { joined.request(KasaSetupCommands.SCAN) }.getOrNull()?.let(::homeNetworksOf).orEmpty()
	}

	fun pickHome(home: HomeNetwork) = state.update { it?.copy(home = home) }

	/** Names the plug and hands it the home network, then waits for it there. */
	suspend fun hand(name: String, password: String, wifiEntry: String?) = runs.withLock {
		val run = state.value ?: return@withLock
		val home = run.home ?: return@withLock
		val began = generation
		settle(began) { it.copy(stage = SetupStage.HANDING, name = name, said = null) }
		val joined = link ?: platform.join(run.networkPrefix)?.also { link = it }
		if (joined == null) return@withLock settle(began) { it.copy(stage = SetupStage.ASK_PASSWORD, said = NOT_JOINED) }
		// Rejoined through the picker: make sure it is the same plug.
		if (runCatchingCancellable { joined.request(KasaSetupCommands.SYSINFO) }.getOrNull()?.let(::plugFactsOf)?.mac != run.plug?.mac) {
			closeLink()
			return@withLock settle(began) { it.copy(stage = SetupStage.ASK_PASSWORD, said = OTHER_PLUG) }
		}
		runCatchingCancellable { joined.request(KasaSetupCommands.alias(name)) }
		// The plug may leave its network before it answers.
		runCatchingCancellable { joined.request(KasaSetupCommands.join(home, password)) }
		closeLink()
		platform.remember(SetupMemory(ssid = home.ssid, wifiEntry = wifiEntry ?: platform.memory().wifiEntry))
		await(began)
	}

	/** Watches again after a slow join. */
	suspend fun watchAgain() = runs.withLock { await(generation) }

	fun cancel() {
		generation++
		closeLink()
		state.value = null
	}

	private suspend fun await(began: Long) {
		val run = state.value ?: return
		val mac = run.plug?.mac ?: return
		settle(began) { it.copy(stage = SetupStage.WAITING, said = null) }
		var waited = 0L
		while (waited < waitMs) {
			if (generation != began) return
			gateway.scan(run.gatewayId)
			val found = gateway.found(run.gatewayId, mac)
			if (found != null) {
				val stored = found == FoundPlug.PAIRED || gateway.add(run.gatewayId, mac, run.name ?: mac)
				return settle(began) {
					if (stored) it.copy(stage = SetupStage.DONE, deviceId = mac) else it.copy(stage = SetupStage.FAILED, said = NOT_ADDED)
				}
			}
			delay(gatewayEveryMs)
			waited += gatewayEveryMs
		}
		settle(began) { it.copy(stage = SetupStage.ASK_PASSWORD, said = NOT_SEEN) }
	}

	private fun settle(began: Long, change: (SetupRun) -> SetupRun) {
		if (generation != began) return
		state.update { it?.let(change) }
	}

	private fun closeLink() {
		link?.let { runIsolated { it.close() } }
		link = null
	}

	companion object {
		const val SETUP_WAIT_MS = 90_000L
		const val NOT_JOINED = "Could not connect to a plug's setup network"
		const val NOT_READ = "The plug did not answer on its setup network"
		const val OTHER_PLUG = "That was a different plug; pick the same one again"
		const val NOT_SEEN = "The plug has not joined your network. If its light blinks again, the password was wrong."
		const val NOT_ADDED = "The plug joined your network, but the Gateway did not add it"
	}
}
