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
	fun start(target: String) = act(target) { gateway, opId -> gateway.start(target, opId) }

	fun stop(target: String) = act(target) { gateway, opId -> gateway.stop(target, opId) }

	/** Op answers at acceptance, so busy until state moves. */
	private fun act(target: String, call: suspend (ContainerGateway, String) -> Unit) {
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
					host.state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "Failed")) }
				}.isSuccess
				if (accepted) withTimeoutOrNull(host.settleCapMs) { host.state.first { containerAt(it, target) != from } }
			} finally {
				host.state.update { it.copy(containerOpsInFlight = it.containerOpsInFlight - target) }
			}
		}
	}
}
