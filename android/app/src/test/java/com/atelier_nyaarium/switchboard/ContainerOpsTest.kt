package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContainerOpsTest {
	private class FakeGateway : ContainerGateway {
		val calls = mutableListOf<String>()
		var answer = CompletableDeferred<Unit>()
		var refusal: String? = null

		override suspend fun start(target: String, opId: String) = called("start $target")

		override suspend fun stop(target: String, opId: String) = called("stop $target")

		private suspend fun called(call: String) {
			calls += call
			answer.await()
			refusal?.let { error(it) }
		}
	}

	private class FakeHost(override val gateway: ContainerGateway?) : ContainerHost {
		override val state = MutableStateFlow(ChatState())

		override fun launchInBackground(block: suspend () -> Unit) {
			CoroutineScope(Dispatchers.Unconfined).launch { block() }
		}
	}

	@Test
	fun aSecondTapWhileTheFirstAwaitsSendsNothingAndTheAnswerFreesTheContainer() {
		val gateway = FakeGateway()
		val host = FakeHost(gateway)
		val ops = ContainerOps(host)

		ops.start("d.gw.app")
		ops.stop("d.gw.app")
		assertEquals(listOf("start d.gw.app"), gateway.calls)
		assertEquals(setOf("d.gw.app"), host.state.value.containerOpsInFlight)

		gateway.answer.complete(Unit)
		ops.stop("d.gw.app")

		assertEquals(listOf("start d.gw.app", "stop d.gw.app"), gateway.calls)
		assertTrue(host.state.value.transientMessages.isEmpty())
	}

	@Test
	fun aRefusalIsToldAndFreesTheContainer() {
		val gateway = FakeGateway().apply {
			answer.complete(Unit)
			refusal = "container_stop failed: no daemon"
		}
		val host = FakeHost(gateway)

		ContainerOps(host).stop("d.gw.app")

		assertEquals(listOf("container_stop failed: no daemon"), host.state.value.transientMessages)
		assertTrue(host.state.value.containerOpsInFlight.isEmpty())
	}

	@Test
	fun noClientIsToldRatherThanDropped() {
		val host = FakeHost(gateway = null)

		ContainerOps(host).start("d.gw.app")

		assertEquals(1, host.state.value.transientMessages.size)
		assertTrue(host.state.value.containerOpsInFlight.isEmpty())
	}
}
