package com.atelier_nyaarium.switchboard

/** A host that can show Switchboard to the owner. */
internal enum class ForegroundHolder { ACTIVITY, PANEL }

internal enum class LeaseEdge { FOREGROUND, BACKGROUND }

/** The held set after a take or a release, and the edge it crossed. */
internal fun leaseStep(held: Set<ForegroundHolder>, holder: ForegroundHolder, take: Boolean): Pair<Set<ForegroundHolder>, LeaseEdge?> {
	val next = if (take) held + holder else held - holder
	val edge = when {
		held.isEmpty() && next.isNotEmpty() -> LeaseEdge.FOREGROUND
		held.isNotEmpty() && next.isEmpty() -> LeaseEdge.BACKGROUND
		else -> null
	}
	return next to edge
}

/**
 * One foreground for the process: the first host shown brings it up, the last one hidden takes it
 * down, so closing the panel never backgrounds an Activity still showing.
 */
internal class ForegroundLease(private val onForeground: () -> Unit, private val onBackground: () -> Unit) {
	private val lock = Any()
	private var held = emptySet<ForegroundHolder>()

	fun take(holder: ForegroundHolder) = step(holder, take = true)

	fun release(holder: ForegroundHolder) = step(holder, take = false)

	private fun step(holder: ForegroundHolder, take: Boolean) = synchronized(lock) {
		val (next, edge) = leaseStep(held, holder, take)
		held = next
		when (edge) {
			LeaseEdge.FOREGROUND -> onForeground()
			LeaseEdge.BACKGROUND -> onBackground()
			null -> Unit
		}
	}
}
