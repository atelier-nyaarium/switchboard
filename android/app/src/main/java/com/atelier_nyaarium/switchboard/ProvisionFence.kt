package com.atelier_nyaarium.switchboard

import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/** Work begun before or during a wipe lands nothing. */
internal class ProvisionFence {
	private val lock = ReentrantReadWriteLock()

	@Volatile private var term = 0L

	@Volatile var clearing = false
		private set

	fun capture(): Long = term

	/** Term once this wipe settles. */
	fun upcoming(): Long = if (clearing) term + 1 else term

	fun isCurrent(captured: Long): Boolean = !clearing && term == captured

	// Outermost lock.
	fun <T> land(captured: Long, write: () -> T): T? = lock.read { if (isCurrent(captured)) write() else null }

	fun advance() = lock.write { clearing = true }

	fun settle() = lock.write {
		term++
		clearing = false
	}
}
