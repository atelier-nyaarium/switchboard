package com.atelier_nyaarium.switchboard

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

internal const val GATEWAY_UNREACHABLE = "This Gateway could not be reached"

/** What a fenced read answers: the body's value, or nothing because a newer read owns the key. */
internal sealed interface GatewayRead<out T> {
	data class Fresh<T>(val value: T) : GatewayRead<T>

	data object Stale : GatewayRead<Nothing>
}

/**
 * Which read of a gateway is the current one. An older answer landing after a newer one would put
 * back what the owner just settled. One counter per gateway, so a slow read of one never discards a
 * fresh read of another.
 */
internal class GatewayReadFence {
	private val counters = ConcurrentHashMap<String, AtomicLong>()

	/**
	 * Claims a read; the body's answer is Fresh only while no later claim of the key exists. The key is
	 * whatever the holder scopes by: a gateway id for the per-gateway tabs, a session address for windows.
	 */
	suspend fun <T> read(key: String, call: suspend () -> T): GatewayRead<T> {
		val counter = counters.computeIfAbsent(key) { AtomicLong(0) }
		val mine = counter.incrementAndGet()
		val value = call()
		return if (mine == counter.get()) GatewayRead.Fresh(value) else GatewayRead.Stale
	}
}
