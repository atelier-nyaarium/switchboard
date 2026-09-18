package com.atelier_nyaarium.switchboard

/** Replaces each key's pending task. */
internal class FakePaintTimer : RawPaintTimer {
	private val pending = mutableMapOf<Any, suspend () -> Unit>()

	override fun debounce(key: Any, delayMs: Long, task: suspend () -> Unit) {
		pending[key] = task
	}

	fun pendingCount(): Int = pending.size

	suspend fun runDue() {
		val due = pending.values.toList()
		pending.clear()
		due.forEach { it() }
	}
}
