package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContainerOpsTest {
	private val target = "d.gw.app"

	private fun row(run: ContainerRun, failure: String? = null) =
		SpawnContainer("app", run, failure, SpawnHarnesses.UNOPENED_CONTAINER)

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

	private inner class FakeHost(override val gateway: ContainerGateway?, override val settleCapMs: Long = 60_000L) : ContainerHost {
		override val state = MutableStateFlow(
			ChatState(gateways = testRegistry("gw").withEntry("gw") { it.copy(containers = listOf(row(ContainerRun.RUNNING))) }),
		)

		override fun launchInBackground(block: suspend () -> Unit) {
			CoroutineScope(Dispatchers.Unconfined).launch { block() }
		}

		fun report(container: SpawnContainer) {
			state.update { s -> s.copy(gateways = s.gateways.withEntry("gw") { it.copy(containers = listOf(container)) }) }
		}
	}

	@Test
	fun theContainerStaysBusyFromTheTapUntilItsReportedStateMoves() {
		val gateway = FakeGateway()
		val host = FakeHost(gateway)
		val ops = ContainerOps(host)

		ops.stop(target)
		ops.start(target)
		assertEquals(listOf("stop $target"), gateway.calls)

		// Still reported running: no Create.
		gateway.answer.complete(Unit)
		assertEquals(setOf(target), host.state.value.containerOpsInFlight)
		ops.start(target)
		assertEquals(listOf("stop $target"), gateway.calls)

		host.report(row(ContainerRun.STOPPED))
		assertTrue(host.state.value.containerOpsInFlight.isEmpty())
		ops.start(target)
		assertEquals(listOf("stop $target", "start $target"), gateway.calls)
	}

	@Test
	fun aFailureLineIsAMoveAndAStateThatNeverMovesFreesAtTheCap() = runBlocking {
		val gateway = FakeGateway().apply { answer.complete(Unit) }
		val failing = FakeHost(gateway)
		ContainerOps(failing).start(target)
		failing.report(row(ContainerRun.RUNNING, failure = "devcontainer up exited 1"))
		assertTrue(failing.state.value.containerOpsInFlight.isEmpty())

		val silent = FakeHost(gateway, settleCapMs = 20L)
		ContainerOps(silent).start(target)
		assertEquals(setOf(target), silent.state.value.containerOpsInFlight)
		delay(200L)
		assertTrue(silent.state.value.containerOpsInFlight.isEmpty())
	}

	@Test
	fun aRefusalIsToldAndFreesTheContainerAtOnce() {
		val gateway = FakeGateway().apply {
			answer.complete(Unit)
			refusal = "container_stop failed: no daemon"
		}
		val host = FakeHost(gateway)

		ContainerOps(host).stop(target)

		assertEquals(listOf("container_stop failed: no daemon"), host.state.value.transientMessages)
		assertTrue(host.state.value.containerOpsInFlight.isEmpty())
	}

	@Test
	fun noClientIsToldRatherThanDropped() {
		val host = FakeHost(gateway = null)

		ContainerOps(host).start(target)

		assertEquals(1, host.state.value.transientMessages.size)
		assertTrue(host.state.value.containerOpsInFlight.isEmpty())
	}
}
