package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadingPostResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

internal enum class RadioReadiness { READY, NOT_GRANTED, OFF, ABSENT }

internal fun readinessLine(readiness: RadioReadiness): String? = when (readiness) {
	RadioReadiness.READY -> null
	RadioReadiness.NOT_GRANTED -> "Nearby devices is not granted"
	RadioReadiness.OFF -> "Bluetooth is off"
	RadioReadiness.ABSENT -> "This phone has no Bluetooth"
}

internal interface BlePlatform {
	fun readiness(): RadioReadiness

	/** Empty when not ready. */
	suspend fun scan(windowMs: Long): List<Sighting>

	/** Empty stops background scans. */
	fun watch(addresses: Set<String>): Boolean
}

internal sealed interface PhoneScanView {
	data object Idle : PhoneScanView

	data object Scanning : PhoneScanView

	data class Heard(val sightings: List<Sighting>) : PhoneScanView

	data class Unavailable(val readiness: RadioReadiness) : PhoneScanView

	data class Failed(val line: String) : PhoneScanView
}

internal class BleScanFailed(code: Int) : Exception("Bluetooth scan failed ($code)")

internal const val PHONE_SCAN_WINDOW_MS = 6_000L

internal class PhoneScanOps(private val platform: () -> BlePlatform?) {
	private val _view = MutableStateFlow<PhoneScanView>(PhoneScanView.Idle)
	val view: StateFlow<PhoneScanView> = _view.asStateFlow()

	suspend fun scan() {
		val radio = platform()
		val readiness = radio?.readiness() ?: RadioReadiness.ABSENT
		if (radio == null || readiness != RadioReadiness.READY) {
			_view.value = PhoneScanView.Unavailable(readiness)
			return
		}
		_view.value = PhoneScanView.Scanning
		_view.value = runCatchingCancellable { radio.scan(PHONE_SCAN_WINDOW_MS) }
			.fold({ PhoneScanView.Heard(it) }) { PhoneScanView.Failed(it.message ?: "Bluetooth scan failed") }
	}
}

internal fun phoneBindings(roster: List<String>, views: Map<String, DevicesView>): Map<String, String> =
	roster.flatMap { gatewayId ->
		(views[gatewayId]?.list as? DeviceListView.Listed)?.records.orEmpty()
			.filter { it.isSensor() && it.onPhones() }
			.map { it.id to gatewayId }
	}.toMap()

/** Retains unlisted bindings. */
internal fun mergedBindings(held: Map<String, String>, roster: List<String>, views: Map<String, DevicesView>): Map<String, String> {
	val listed = roster.filter { views[it]?.list is DeviceListView.Listed }.toSet()
	val kept = held.filterValues { it in roster && it !in listed }
	return kept + phoneBindings(roster, views)
}

/** Unloaded roster keeps bindings. */
internal fun bindingsAfter(held: Map<String, String>, roster: GatewayRegistry, views: Map<String, DevicesView>): Map<String, String> =
	if (roster.loaded) mergedBindings(held, roster.ids(), views) else held

internal val BindingsSerializer = MapSerializer(String.serializer(), String.serializer())

internal data class Posted(val advert: Advert, val at: Long)

internal const val REPOST_MS = 5 * 60_000L

/** Posts changes and intervals. */
internal fun shouldPost(last: Posted?, advert: Advert, now: Long): Boolean =
	last == null || last.advert != advert || now - last.at >= REPOST_MS

/** Reposts after process restart. */
internal class BleReadings(
	private val scope: CoroutineScope,
	private val bindings: () -> Map<String, String>,
	private val gateway: () -> DeviceGateway?,
	private val now: () -> Long,
	/** Held while a post runs. */
	private val hold: () -> Unit = {},
	private val release: () -> Unit = {},
) {
	private val last = mutableMapOf<String, Posted>()
	private var inflight = 0

	/** Newest capture per address. */
	fun accept(sightings: List<Sighting>): Int {
		val bound = bindings()
		val due = synchronized(last) {
			val newest = sightings.filter { bound[it.mac] != null && familyOf(it.advert) != null }
				.groupBy { it.mac }
				.map { (_, rows) -> rows.reversed().maxBy { it.at ?: Long.MIN_VALUE } }
			val picked = newest.map { it to Posted(it.advert, it.at ?: now()) }.filter { (sighting, posted) ->
				shouldPost(last[sighting.mac], sighting.advert, posted.at)
			}
			for ((sighting, posted) in picked) last[sighting.mac] = posted
			// Renew hold per batch.
			if (picked.isNotEmpty()) {
				inflight += 1
				hold()
			}
			picked
		}
		if (due.isEmpty()) return 0
		scope.launch {
			try {
				val client = gateway()
				for ((sighting, posted) in due) {
					val gatewayId = bound[sighting.mac] ?: continue
					val answer = client?.let { held ->
						runCatchingCancellable { held.postReading(gatewayId, sighting.mac, advertOf(sighting.advert), posted.at) }
							.onFailure { DebugLog.log("Radio", "reading post failed: ${it.javaClass.simpleName}") }
							.getOrNull()
					}
					val landed = (answer as? DeviceAnswer.Answered)?.value == ConsoleDeviceReadingPostResult.Ok
					// The next sighting retries.
					if (!landed) synchronized(last) { if (last[sighting.mac] == posted) last.remove(sighting.mac) }
				}
			} finally {
				synchronized(last) { if (--inflight == 0) release() }
			}
		}
		return due.size
	}
}

internal interface BindingsStore {
	fun load(): Map<String, String>

	fun save(bindings: Map<String, String>)
}

internal const val WATCH_RETRY_MS = 30_000L

/** Five starts per 30s. */
internal const val START_GAP_MS = WATCH_RETRY_MS / 5

/** Sole radio registration owner. */
internal class PhoneRadio(
	private val scope: CoroutineScope,
	private val platform: BlePlatform,
	private val persisted: BindingsStore,
	gateway: () -> DeviceGateway?,
	private val now: () -> Long,
	hold: () -> Unit = {},
	release: () -> Unit = {},
	private val pause: suspend (Long) -> Unit = { delay(it) },
) {
	private sealed interface Event {
		data class Roster(val roster: GatewayRegistry, val views: Map<String, DevicesView>) : Event

		/** Registration may be gone. */
		data object Lost : Event

		/** Reconcile current registration. */
		data object Check : Event

		data object Retry : Event
	}

	private val events = Channel<Event>(Channel.UNLIMITED)

	@Volatile
	private var wanted: Map<String, String> = persisted.load()

	/** Null is unknown. */
	private var registered: Set<String>? = null
	private var lastStart: Long? = null

	/** A Retry is pending. */
	private var retrying = false

	private val readings = BleReadings(scope, { wanted }, gateway, now, hold, release)
	private val scans = PhoneScanOps { platform }

	val scanView: StateFlow<PhoneScanView> get() = scans.view

	init {
		scope.launch { for (event in events) apply(event) }
		events.trySend(Event.Check)
	}

	fun readiness(): RadioReadiness = platform.readiness()

	fun rosterChanged(roster: GatewayRegistry, views: Map<String, DevicesView>) {
		events.trySend(Event.Roster(roster, views))
	}

	fun radioOn() {
		events.trySend(Event.Lost)
	}

	fun radioOff() {
		events.trySend(Event.Lost)
	}

	fun scanLost() {
		events.trySend(Event.Lost)
	}

	fun resumed() {
		events.trySend(Event.Check)
	}

	/** Hold before receiver returns. */
	fun heard(sightings: List<Sighting>): Int = readings.accept(sightings)

	suspend fun scan() {
		scans.scan()
		events.send(Event.Check)
	}

	private fun apply(event: Event) {
		val before = wanted.keys
		when (event) {
			is Event.Roster -> {
				val next = bindingsAfter(wanted, event.roster, event.views)
				if (next != wanted) {
					persisted.save(next)
					wanted = next
				}
			}
			Event.Lost -> registered = null
			Event.Retry -> retrying = false
			Event.Check -> Unit
		}
		if (retrying && wanted.keys == before) return
		reconcile()
	}

	private fun reconcile() {
		val want = wanted.keys
		if (registered == want) return
		val gap = lastStart?.let { START_GAP_MS - (now() - it) } ?: 0L
		if (gap > 0) return retryIn(gap)
		lastStart = now()
		registered = want.takeIf { platform.watch(want) }
		if (registered == null && platform.readiness() == RadioReadiness.READY) retryIn(WATCH_RETRY_MS)
	}

	private fun retryIn(ms: Long) {
		if (retrying) return
		retrying = true
		scope.launch {
			pause(ms)
			events.send(Event.Retry)
		}
	}
}
