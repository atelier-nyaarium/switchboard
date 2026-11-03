package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.StateFlow

/** One part of a view. */
internal interface Slot<V : Any, S> {
	fun owned(view: V): Boolean = true

	fun read(view: V): S

	fun write(view: V, part: S): V
}

/** PublishedViews landing one slot per ticket. */
internal class SlotViews<K : Any, V : Any>(generation: WorkspaceGeneration, private val initial: () -> V) {
	class Ticket<K : Any, V : Any, S> internal constructor(
		internal val inner: PublishedViews.ReadTicket<K>,
		internal val slot: Slot<V, S>,
	)

	private val views = PublishedViews<K, V>(generation)

	val all: StateFlow<Map<K, V>> get() = views.all

	fun of(key: K): V? = views.of(key)

	fun <S> begin(key: K, slot: Slot<V, S>): Ticket<K, V, S> =
		Ticket(views.ticket(views.show(key, initial).showing, slot), slot)

	fun <S> land(ticket: Ticket<K, V, S>, change: (S) -> S): Boolean =
		views.claim(
			ticket.inner,
			{ ticket.slot.owned(it) },
		) { view ->
			ticket.slot.write(view, change(ticket.slot.read(view)))
		} != null

	fun <S> claim(ticket: Ticket<K, V, S>, take: (S) -> Boolean, taken: (S) -> S): Boolean =
		views.claim(
			ticket.inner,
			{ view -> ticket.slot.owned(view) && take(ticket.slot.read(view)) },
		) { view ->
			ticket.slot.write(view, taken(ticket.slot.read(view)))
		} != null

	fun <S> now(key: K, slot: Slot<V, S>, change: (S) -> S): Boolean =
		views.now(key) { view ->
			if (slot.owned(view)) slot.write(view, change(slot.read(view))) else view
		}

	fun clear() = views.clear()
}
