package com.atelier_nyaarium.switchboard

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * What each shown screen draws, keyed by what it shows. Awaited work lands only through a `ReadTicket`
 * minted before it awaits: a leave, a newer showing of the key, a re-provision or a later ticket of the
 * same slot landing first all drop its answer. The one guard for a view map an ops class publishes beside
 * `HeldEdits`, so none chooses its own.
 */
internal class PublishedViews<K : Any, V : Any>(private val generation: WorkspaceGeneration) {
	/** Where work began. Opaque, so no caller compares its parts. */
	class Showing<K> internal constructor(val key: K, internal val token: Any, internal val generation: Long)

	/**
	 * A showing, and whether this call started it. Only the starter loads, or two keepers arriving on one
	 * key each read it.
	 */
	class Opened<K> internal constructor(val showing: Showing<K>, val started: Boolean)

	/**
	 * One read's place in the order of its key and slot. Minted before the read awaits, or it orders
	 * nothing. A null slot is a view one read fills; a view whose halves land apart names a slot each.
	 */
	class ReadTicket<K> internal constructor(
		val showing: Showing<K>,
		internal val slot: Any?,
		internal val order: Long,
	) {
		val key: K get() = showing.key
	}

	/** Showings, keepers, orders and `drawn` change only under it, so no reader sees one moved without the others. */
	private val lock = Any()

	/** The showing open now for each key, as it was minted. */
	private val showings = HashMap<K, Showing<K>>()

	/** Outlives a clear: a kept screen shows its key again. */
	private val keepers = HashMap<K, Int>()

	/** A showing's read, held by its key rather than by the keeper that started it. */
	private val reads = HashMap<K, Job>()

	/** The newest ticket that landed on each key and slot. */
	private val landings = HashMap<Pair<K, Any?>, Long>()

	private var minted = 0L

	private val drawn = MutableStateFlow<Map<K, V>>(emptyMap())

	/** Absent: no screen has asked, or it left. */
	val all: StateFlow<Map<K, V>> = drawn

	fun of(key: K): V? = drawn.value[key]

	/** The keys a screen is holding open, for a sweep that reads them by key. */
	fun kept(): Set<K> = synchronized(lock) { keepers.keys.toSet() }

	/** Joins the showing of `key` already open, or starts one drawn as `initial`. */
	fun show(key: K, initial: () -> V): Opened<K> =
		synchronized(lock) {
			val started = key !in drawn.value
			val showing = if (started) start(key, initial) else showings.getValue(key)
			Opened(showing, started)
		}

	/** A new showing that ends any before it, its read included, keeping what is drawn. */
	fun reshow(key: K, initial: () -> V): Showing<K> =
		synchronized(lock) {
			reads.remove(key)?.cancel()
			start(key, initial)
		}

	private fun start(key: K, initial: () -> V): Showing<K> {
		if (key !in drawn.value) drawn.value = drawn.value + (key to initial())
		val showing = Showing(key, Any(), generation.capture())
		showings[key] = showing
		return showing
	}

	/** A ticket on a showing in hand, for a second slot of it or for work about to begin. */
	fun ticket(showing: Showing<K>, slot: Any? = null): ReadTicket<K> =
		synchronized(lock) { ReadTicket(showing, slot, ++minted) }

	/** A ticket on the showing open now, as it was minted; null when nothing shows the key. */
	fun begin(key: K, slot: Any? = null): ReadTicket<K>? =
		synchronized(lock) {
			val showing = showings[key] ?: return null
			ReadTicket(showing, slot, ++minted)
		}

	fun isCurrent(showing: Showing<K>): Boolean = synchronized(lock) { currentLocked(showing) }

	private fun currentLocked(showing: Showing<K>): Boolean =
		showings[showing.key]?.token === showing.token && generation.isCurrent(showing.generation)

	private fun landsLocked(ticket: ReadTicket<K>): Boolean =
		currentLocked(ticket.showing) && (landings[ticket.key to ticket.slot] ?: 0L) <= ticket.order

	/**
	 * False when the showing has ended or a later read of this slot landed first, which changes nothing.
	 * `change` runs under the lock, so it must not block.
	 */
	fun update(ticket: ReadTicket<K>, change: (V) -> V): Boolean =
		synchronized(lock) {
			val view = drawn.value[ticket.key]
			if (view == null || !landsLocked(ticket)) return false
			landings[ticket.key to ticket.slot] = ticket.order
			drawn.value = drawn.value + (ticket.key to change(view))
			true
		}

	/** The view as it was, when `take` accepts it and it is replaced by `taken`; null otherwise. */
	fun claim(ticket: ReadTicket<K>, take: (V) -> Boolean, taken: (V) -> V): V? =
		synchronized(lock) {
			val view = drawn.value[ticket.key]?.takeIf { landsLocked(ticket) && take(it) } ?: return null
			landings[ticket.key to ticket.slot] = ticket.order
			drawn.value = drawn.value + (ticket.key to taken(view))
			view
		}

	/** A change that awaited nothing, on whatever showing stands. False when nothing draws the key. */
	fun now(key: K, change: (V) -> V): Boolean =
		synchronized(lock) {
			val view = drawn.value[key] ?: return false
			drawn.value = drawn.value + (key to change(view))
			true
		}

	/**
	 * Shows `key` while the caller runs, and loads it again whenever a re-provision clears it. A second
	 * keeper of one key joins what is drawn and loads nothing. The ticket is minted here, so a keeper
	 * cannot forget to take one.
	 */
	suspend fun keep(key: K, initial: () -> V, load: suspend (ReadTicket<K>) -> Unit) {
		synchronized(lock) { keepers[key] = (keepers[key] ?: 0) + 1 }
		try {
			coroutineScope {
				all.collect {
					// Asked of every value, since a conflated collector can miss a present one, and asked
					// rather than read off the value, which another keeper can be between.
					val opened = show(key, initial)
					if (opened.started) {
						val ticket = ticket(opened.showing)
						read(opened.showing) { load(ticket) }
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

	/**
	 * The showing's read, parented to a job of its own rather than to the keeper that started it: a keeper
	 * leaving while others remain must not take the read with it. The last keeper leaving, a `leave` and a
	 * `clear` are what end one.
	 */
	private fun CoroutineScope.read(showing: Showing<K>, load: suspend () -> Unit) {
		val job = launch(Job(), CoroutineStart.LAZY) {
			try {
				load()
			} catch (e: CancellationException) {
				reopen(showing)
				throw e
			} catch (e: Exception) {
				// Reopening a read that throws would ask again at once, and again.
				DebugLog.log("PublishedViews", "read failed: ${e.message}")
			}
		}
		synchronized(lock) {
			if (!currentLocked(showing)) {
				job.cancel()
				return
			}
			reads.put(showing.key, job)?.cancel()
		}
		job.invokeOnCompletion { synchronized(lock) { if (reads[showing.key] === job) reads.remove(showing.key) } }
		job.start()
	}

	/** A read that ended without finishing draws nothing, so the keepers left ask for another. */
	private fun reopen(showing: Showing<K>) {
		synchronized(lock) {
			if (!currentLocked(showing) || showing.key !in keepers) return
			drawn.value = drawn.value - showing.key
		}
	}

	fun leave(key: K) {
		synchronized(lock) { leaveLocked(key) }
	}

	private fun leaveLocked(key: K) {
		showings.remove(key)
		reads.remove(key)?.cancel()
		landings.keys.removeAll { it.first == key }
		drawn.value = drawn.value - key
	}

	fun clear() {
		synchronized(lock) {
			showings.clear()
			for (job in reads.values) job.cancel()
			reads.clear()
			landings.clear()
			drawn.value = emptyMap()
		}
	}
}
