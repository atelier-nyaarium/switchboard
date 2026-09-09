package com.atelier_nyaarium.switchboard

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Which read of a gateway is the current one. The drain loop and a tap on the screen both start
 * reads, on different threads, so an older answer can land after a newer one and put back what the
 * owner just settled. One counter per gateway: a slow read of one never discards a fresh read of
 * another.
 */
internal class GatewayReadFence {
	private val counters = ConcurrentHashMap<String, AtomicLong>()

	/** Claims a read. `null` from the body, or an answer that is no longer current, is dropped. */
	suspend fun <T> read(gatewayId: String, call: suspend () -> T?): T? {
		val counter = counters.computeIfAbsent(gatewayId) { AtomicLong(0) }
		val mine = counter.incrementAndGet()
		val answer = call() ?: return null
		return answer.takeIf { mine == counter.get() }
	}
}
