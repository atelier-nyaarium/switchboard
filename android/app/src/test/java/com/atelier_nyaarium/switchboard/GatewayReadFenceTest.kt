package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayReadFenceTest {
	@Test
	fun aFailedBodyIsFreshAndNullWhileASupersededReadIsStale() = runBlocking {
		val fence = GatewayReadFence()
		assertEquals(GatewayRead.Fresh<String?>(null), fence.read<String?>("sakura") { null })

		val entered = CompletableDeferred<Unit>()
		val gate = CompletableDeferred<Unit>()
		val older = async {
			fence.read("sakura") {
				entered.complete(Unit)
				gate.await()
				"older"
			}
		}
		entered.await()
		assertEquals(GatewayRead.Fresh("newer"), fence.read("sakura") { "newer" })
		gate.complete(Unit)
		assertEquals(GatewayRead.Stale, older.await())

		// Another gateway's read is not superseded by this one's.
		assertEquals(GatewayRead.Fresh("mikan"), fence.read("mikan") { "mikan" })
	}
}
