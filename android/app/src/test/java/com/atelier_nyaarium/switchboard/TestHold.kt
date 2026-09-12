package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred

/**
 * Holds one call inside a fake until the test lets it finish, which is how an overtaking call is
 * staged deterministically. Shared, since a per-file copy collides at the JVM level.
 */
internal class TestHold {
	val entered = CompletableDeferred<Unit>()
	val gate = CompletableDeferred<Unit>()

	/** Called by the fake: says it arrived, then waits. */
	suspend fun pass() {
		entered.complete(Unit)
		gate.await()
	}

	/** Called by the test: waits for the call to arrive, then lets it go. */
	suspend fun release() {
		entered.await()
		gate.complete(Unit)
	}
}
