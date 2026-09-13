package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * What each shown screen draws, keyed by what it shows. Awaited work lands only on the showing it began in: a
 * leave, a newer showing of the key or a re-provision ends that showing, and its answer is dropped. The one
 * guard for a view map an ops class publishes beside `HeldEdits`, so none chooses its own.
 */
internal class PublishedViews<K : Any, V : Any>(private val generation: WorkspaceGeneration) {
	/** Where work began. Opaque, so no caller compares its parts. */
	class Showing<K> internal constructor(val key: K, internal val token: Any, internal val generation: Long)

	/** Tokens, keepers and `drawn` change only under it, so no reader sees one moved without the others. */
	private val lock = Any()

	private val tokens = HashMap<K, Any>()

	/** Outlives a clear: a kept screen shows its key again. */
	private val keepers = HashMap<K, Int>()

	private val drawn = MutableStateFlow<Map<K, V>>(emptyMap())

	/** Absent: no screen has asked, or it left. */
	val all: StateFlow<Map<K, V>> = drawn

	fun of(key: K): V? = drawn.value[key]

	/** Joins the showing of `key` already open, or starts one drawn as `initial`. */
	fun show(key: K, initial: () -> V): Showing<K> =
		synchronized(lock) { start(key, tokens.getOrPut(key) { Any() }, initial) }

	/** A new showing that ends any before it, keeping what is drawn. */
	fun reshow(key: K, initial: () -> V): Showing<K> =
		synchronized(lock) { start(key, Any().also { tokens[key] = it }, initial) }

	private fun start(key: K, token: Any, initial: () -> V): Showing<K> {
		if (key !in drawn.value) drawn.value = drawn.value + (key to initial())
		return Showing(key, token, generation.capture())
	}

	/** The showing open now, for work begun without one. */
	fun current(key: K): Showing<K>? = synchronized(lock) { tokens[key]?.let { Showing(key, it, generation.capture()) } }

	fun isCurrent(showing: Showing<K>): Boolean = synchronized(lock) { currentLocked(showing) }

	private fun currentLocked(showing: Showing<K>): Boolean =
		tokens[showing.key] === showing.token && generation.isCurrent(showing.generation)

	/** False when the showing has ended, which changes nothing. `change` runs under the lock, so it must not block. */
	fun update(showing: Showing<K>, change: (V) -> V): Boolean =
		synchronized(lock) {
			val view = drawn.value[showing.key]
			if (view == null || !currentLocked(showing)) return false
			drawn.value = drawn.value + (showing.key to change(view))
			true
		}

	/** The view as it was, when `take` accepts it and it is replaced by `taken`; null otherwise. */
	fun claim(showing: Showing<K>, take: (V) -> Boolean, taken: (V) -> V): V? =
		synchronized(lock) {
			val view = drawn.value[showing.key]?.takeIf { currentLocked(showing) && take(it) } ?: return null
			drawn.value = drawn.value + (showing.key to taken(view))
			view
		}

	/** Shows `key` while the caller runs, and loads it again whenever a re-provision clears it. */
	suspend fun keep(key: K, initial: () -> V, load: suspend (Showing<K>) -> Unit) {
		synchronized(lock) { keepers[key] = (keepers[key] ?: 0) + 1 }
		try {
			coroutineScope {
				all.collect { views ->
					// Shown before the next value, since a conflated collector can miss a present one.
					if (key !in views) {
						val showing = show(key, initial)
						launch { load(showing) }
					}
				}
			}
		} finally {
			synchronized(lock) {
				val left = (keepers[key] ?: 1) - 1
				if (left > 0) {
					keepers[key] = left
				} else {
					keepers.remove(key)
					leaveLocked(key)
				}
			}
		}
	}

	fun leave(key: K) {
		synchronized(lock) { leaveLocked(key) }
	}

	private fun leaveLocked(key: K) {
		tokens.remove(key)
		drawn.value = drawn.value - key
	}

	fun clear() {
		synchronized(lock) {
			tokens.clear()
			drawn.value = emptyMap()
		}
	}
}
