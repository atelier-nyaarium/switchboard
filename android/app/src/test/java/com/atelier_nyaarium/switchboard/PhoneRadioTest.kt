package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

private const val KITCHEN = "02:00:00:00:00:31"
private const val PANTRY = "02:00:00:00:00:32"

private class FakeRadio : BlePlatform {
	var readiness = RadioReadiness.READY
	var accepts = true
	val watched = mutableListOf<Set<String>>()

	override fun readiness() = readiness

	override suspend fun scan(windowMs: Long): List<Sighting> = emptyList()

	override fun watch(addresses: Set<String>): Boolean {
		watched += addresses
		return readiness == RadioReadiness.READY && accepts
	}
}

private class MemoryBindings(var held: Map<String, String> = emptyMap()) : BindingsStore {
	override fun load() = held

	override fun save(bindings: Map<String, String>) {
		held = bindings
	}
}

private fun roster(vararg ids: String) =
	GatewayRegistry(provenance = RegistryProvenance.Current, gateways = ids.map { GatewayEntry(it, connected = true, incarnation = 1L, lastRegisteredAt = 0L) })

private fun listing(vararg ids: String) = DevicesView(
	list = DeviceListView.Listed(
		ids.map { DeviceRecord(id = it, name = it, kind = "sensor", driver = "govee", address = it, radio = "phones", revision = 1L) },
		1L,
	),
)

private class Clock(var at: Long = 0L)

private fun radio(platform: FakeRadio, store: MemoryBindings, clock: Clock = Clock(), pause: suspend (Long) -> Unit = { awaitCancellation() }) =
	PhoneRadio(CoroutineScope(Dispatchers.Unconfined), platform, store, { null }, { clock.at }, pause = pause)

class PhoneRadioTest {
	@Test
	fun `a cold start registers the saved set before the roster loads, and an unchanged roster registers nothing more`() {
		val platform = FakeRadio()
		val store = MemoryBindings(mapOf(KITCHEN to "sakura"))
		val clock = Clock()
		val owner = radio(platform, store, clock)
		owner.rosterChanged(GatewayRegistry(), emptyMap())
		owner.rosterChanged(roster("sakura"), mapOf("sakura" to listing(KITCHEN)))
		assertEquals(listOf(setOf(KITCHEN)), platform.watched)
		clock.at = START_GAP_MS
		owner.rosterChanged(roster("sakura"), mapOf("sakura" to listing(KITCHEN, PANTRY)))
		assertEquals(listOf(setOf(KITCHEN), setOf(KITCHEN, PANTRY)), platform.watched)
		assertEquals(mapOf(KITCHEN to "sakura", PANTRY to "sakura"), store.held)
	}

	@Test
	fun `a burst of lost scans starts the radio once, then again when the gap passes`() = runBlocking {
		val platform = FakeRadio()
		val clock = Clock()
		val retry = Channel<Unit>()
		val owner = radio(platform, MemoryBindings(mapOf(KITCHEN to "sakura")), clock) { retry.receive() }
		repeat(5) { owner.scanLost() }
		owner.resumed()
		assertEquals(1, platform.watched.size)
		clock.at = START_GAP_MS
		retry.send(Unit)
		assertEquals(2, platform.watched.size)
		clock.at = 2 * START_GAP_MS
		owner.radioOn()
		owner.resumed()
		assertEquals(3, platform.watched.size)
	}

	@Test
	fun `a grant on resume registers, and a refused start waits for its retry unless the set changes`() {
		val platform = FakeRadio().apply { readiness = RadioReadiness.NOT_GRANTED }
		val clock = Clock()
		val owner = radio(platform, MemoryBindings(mapOf(KITCHEN to "sakura")), clock)
		platform.readiness = RadioReadiness.READY
		clock.at = START_GAP_MS
		owner.resumed()
		assertEquals(2, platform.watched.size)
		platform.accepts = false
		clock.at = 2 * START_GAP_MS
		owner.scanLost()
		assertEquals(3, platform.watched.size)
		clock.at = 3 * START_GAP_MS
		repeat(3) {
			owner.resumed()
			owner.rosterChanged(roster("sakura"), mapOf("sakura" to listing(KITCHEN)))
		}
		assertEquals(3, platform.watched.size)
		owner.rosterChanged(roster("sakura"), mapOf("sakura" to listing(KITCHEN, PANTRY)))
		assertEquals(4, platform.watched.size)
	}

	@Test
	fun `a roster change and a resume landing together leave the new set registered and saved`() = runBlocking {
		val platform = FakeRadio()
		val store = MemoryBindings(mapOf(KITCHEN to "sakura"))
		val clock = Clock()
		val owner = radio(platform, store, clock)
		clock.at = START_GAP_MS
		owner.rosterChanged(roster("mikan"), mapOf("mikan" to listing(PANTRY)))
		owner.resumed()
		owner.scan()
		assertEquals(setOf(PANTRY), platform.watched.last())
		assertEquals(mapOf(PANTRY to "mikan"), store.held)
	}
}
