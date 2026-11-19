package com.atelier_nyaarium.switchboard

import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull

////////////////////////////////
//  Interfaces & Types

/** Start and Stop, each answered once queued. The outcome rides the container state. */
internal interface ContainerGateway {
	suspend fun start(target: String, opId: String)
	suspend fun stop(target: String, opId: String)
}

internal interface ContainerHost {
	val state: MutableStateFlow<ChatState>
	/** Null with no client. */
	val gateway: ContainerGateway?
	/** Wait for state to move after acceptance. */
	val settleCapMs: Long
	fun launchInBackground(block: suspend () -> Unit)
}

////////////////////////////////
//  Constants

internal const val CONTAINER_SETTLE_CAP_MS = 60_000L

////////////////////////////////
//  Classes

/** A container's Start and Stop, keyed by its spawn point address. */
internal class ContainerOps(private val host: ContainerHost) {
	fun start(target: String) = act(target, Act.STARTING_CONTAINER) { gateway, opId -> gateway.start(target, opId) }

	fun stop(target: String) = act(target, Act.STOPPING_CONTAINER) { gateway, opId -> gateway.stop(target, opId) }

	/** Starts [target] and tells [settled] once, when it runs or when its start fails. */
	fun startThen(target: String, settled: (ContainerSettle) -> Unit) {
		val before = containerAt(host.state.value, target)
		start(target)
		host.launchInBackground {
			val end = host.state.first {
				containerSettle(before, containerAt(it, target), target in it.containerOpsInFlight) != null
			}
			containerSettle(before, containerAt(end, target), target in end.containerOpsInFlight)?.let(settled)
		}
	}

	/** Op answers at acceptance, so busy until state moves. */
	private fun act(target: String, doing: Act, call: suspend (ContainerGateway, String) -> Unit) {
		val key = "container:$target"
		val from = containerAt(host.state.value, target)
		val before = host.state.getAndUpdate {
			if (target in it.containerOpsInFlight) it else it.copy(containerOpsInFlight = it.containerOpsInFlight + target)
		}
		if (target in before.containerOpsInFlight) return
		host.launchInBackground {
			try {
				val accepted = runCatchingCancellable {
					val gateway = host.gateway ?: error("Not connected")
					call(gateway, UUID.randomUUID().toString())
				}.onFailure { e ->
					DebugLog.log("Container", "target=$target failed: ${e.message?.take(160)}")
					host.state.update { it.withNotice(thrownSentence(doing, e), key = key) }
				}.onSuccess { host.state.update { it.withoutNoticeKey(key) } }.isSuccess
				if (accepted) withTimeoutOrNull(host.settleCapMs) { host.state.first { containerAt(it, target) != from } }
			} finally {
				host.state.update { it.copy(containerOpsInFlight = it.containerOpsInFlight - target) }
			}
		}
	}
}
