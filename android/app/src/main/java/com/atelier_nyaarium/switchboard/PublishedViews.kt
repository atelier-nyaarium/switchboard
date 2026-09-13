package com.atelier_nyaarium.switchboard

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * What each shown screen draws, keyed by what it shows. Awaited work lands only on the showing it began in: a
 * leave, a newer showing of the key or a re-provision ends that showing, and its answer is dropped. The one
 * guard for a view map an ops class publishes beside `HeldEdits`, so none chooses its own.
 */
internal class PublishedViews<K : Any, V : Any>(private val generation: WorkspaceGeneration) {
	/** Where work began. Opaque, so no caller compares its parts. */
	class Showing<K> internal constructor(val key: K, internal val token: Any, internal val generation: Long)

	private val drawn = MutableStateFlow<Map<K, V>>(emptyMap())

	private val showings = ConcurrentHashMap<K, Any>()

	/** Absent: no screen has asked, or it left. */
	val all: StateFlow<Map<K, V>> = drawn

	fun of(key: K): V? = drawn.value[key]

	/** Joins the showing of `key` already open, or starts one drawn as `initial`. */
	fun show(key: K, initial: () -> V): Showing<K> = start(key, showings.computeIfAbsent(key) { Any() }, initial)

	/** A new showing that ends any before it, keeping what is drawn. */
	fun reshow(key: K, initial: () -> V): Showing<K> = start(key, Any().also { showings[key] = it }, initial)

	private fun start(key: K, token: Any, initial: () -> V): Showing<K> {
		drawn.update { all -> if (key in all) all else all + (key to initial()) }
		return Showing(key, token, generation.capture())
	}

	/** The showing open now, for work begun without one. */
	fun current(key: K): Showing<K>? = showings[key]?.let { Showing(key, it, generation.capture()) }

	fun isCurrent(showing: Showing<K>): Boolean =
		showings[showing.key] === showing.token && generation.isCurrent(showing.generation)

	/** False when the showing has ended, which changes nothing. */
	fun update(showing: Showing<K>, change: (V) -> V): Boolean {
		var landed = false
		drawn.update { all ->
			val view = all[showing.key]
			landed = view != null && isCurrent(showing)
			if (landed) all + (showing.key to change(view!!)) else all
		}
		return landed
	}

	/** The view as it was, when `take` accepts it and it is replaced by `taken`; null otherwise. */
	fun claim(showing: Showing<K>, take: (V) -> Boolean, taken: (V) -> V): V? {
		var claimed: V? = null
		drawn.update { all ->
			claimed = all[showing.key]?.takeIf { isCurrent(showing) && take(it) }
			claimed?.let { all + (showing.key to taken(it)) } ?: all
		}
		return claimed
	}

	fun leave(key: K) {
		showings.remove(key)
		drawn.update { it - key }
	}

	fun clear() {
		showings.clear()
		drawn.value = emptyMap()
	}
}
