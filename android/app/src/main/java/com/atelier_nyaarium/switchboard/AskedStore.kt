package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** One question of one symbol, in one session's workspace under one root label. */
internal data class AskedKey(val address: String, val root: String, val symbolId: String, val question: String)

internal data class AskSend(
	/** The road's incarnation for this send, so a replacement is never mistaken for what it replaced. */
	val id: Long,
	val sentAt: Long,
	val address: String,
	val root: String,
	val scopeSubject: String,
	/** Each pair's createdAt in the read the send used. */
	val pairs: Map<AskedKey, Double?>,
	val recorded: Set<AskedKey> = emptySet(),
)

/**
 * What one read says about a session's pairs, in the ledger's own words. `listed` holds only the pairs
 * the read carried, so an absent key is one it no longer lists and settles nothing.
 */
internal data class AskObservation(val address: String, val root: String, val listed: Map<AskedKey, Double?>) {
	fun moved(key: AskedKey, stamped: Double?): Boolean = listed.containsKey(key) && listed[key] != stamped
}

internal const val ASKED_TTL_MS = 24L * 60 * 60 * 1000

/**
 * The sends still out and their pairs, keyed by SESSION. A pair clears when an observation's
 * `createdAt` moves from the value the read the send used carried, never by comparing the phone's
 * clock to Lexicon's. A ledger of sends and pairs alone, so it names no wire type. Memory only, so a
 * re-provision and a process death both drop it.
 */
internal class AskedStore(private val now: () -> Long) {
	/** Pruning and writing under one lock, or a read prunes what a write just appended. */
	private val lock = Any()

	private val held = MutableStateFlow<List<AskSend>>(emptyList())

	/** Newest last. */
	val sends: StateFlow<List<AskSend>> = held

	fun record(id: Long, address: String, root: String, scopeSubject: String, pairs: Map<AskedKey, Double?>): AskSend {
		val send = AskSend(
			id = id,
			sentAt = now(),
			address = address,
			root = root,
			scopeSubject = scopeSubject,
			pairs = pairs,
		)
		synchronized(lock) { held.value = live() + send }
		return send
	}

	fun withdraw(id: Long) {
		synchronized(lock) { held.value = live().filterNot { it.id == id } }
	}

	/**
	 * The symbols whose recorded set grew, so the caller reloads only those. An observation under another
	 * root matches nothing, since the pairs were keyed by the root the send read.
	 */
	fun settle(observation: AskObservation): Set<String> =
		synchronized(lock) {
			val grew = mutableSetOf<String>()
			held.value = live().map { send ->
				if (send.address != observation.address || send.root != observation.root) return@map send
				val moved = send.pairs.keys.filter { key ->
					key !in send.recorded && observation.moved(key, send.pairs[key])
				}
				if (moved.isEmpty()) return@map send
				moved.mapTo(grew) { it.symbolId }
				send.copy(recorded = send.recorded + moved)
			}
			grew
		}

	fun outstanding(key: AskedKey): Boolean = synchronized(lock) { outstandingIn(live(), key) }

	fun anyOutstanding(): Boolean =
		synchronized(lock) {
			val live = live()
			live.any { send -> send.pairs.keys.any { outstandingIn(live, it) } }
		}

	fun latestFor(address: String, root: String, scopeSubject: String): AskSend? =
		synchronized(lock) {
			live().lastOrNull { it.address == address && it.root == root && it.scopeSubject == scopeSubject }
		}

	fun clear() {
		synchronized(lock) { held.value = emptyList() }
	}

	/** The newest send holding a pair is the one it is out on; older copies stay for progress. */
	private fun outstandingIn(live: List<AskSend>, key: AskedKey): Boolean =
		live.lastOrNull { key in it.pairs }?.let { key !in it.recorded } ?: false

	private fun live(): List<AskSend> {
		val at = now()
		val kept = held.value.filter { at - it.sentAt < ASKED_TTL_MS }
		if (kept.size != held.value.size) held.value = kept
		return kept
	}
}
