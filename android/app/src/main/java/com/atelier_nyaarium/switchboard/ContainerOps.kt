package com.atelier_nyaarium.switchboard

import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update

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
	fun launchInBackground(block: suspend () -> Unit)
}

////////////////////////////////
//  Classes

/** A container's Start and Stop, keyed by its spawn point address. */
internal class ContainerOps(private val host: ContainerHost) {
	fun start(target: String) = act(target) { gateway, opId -> gateway.start(target, opId) }

	fun stop(target: String) = act(target) { gateway, opId -> gateway.stop(target, opId) }

	/** One op per container until it answers. */
	private fun act(target: String, call: suspend (ContainerGateway, String) -> Unit) {
		val before = host.state.getAndUpdate {
			if (target in it.containerOpsInFlight) it else it.copy(containerOpsInFlight = it.containerOpsInFlight + target)
		}
		if (target in before.containerOpsInFlight) return
		host.launchInBackground {
			try {
				runCatchingCancellable {
					val gateway = host.gateway ?: error("Not connected")
					call(gateway, UUID.randomUUID().toString())
				}.onFailure { e ->
					DebugLog.log("Container", "target=$target failed: ${e.message?.take(160)}")
					host.state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "Failed")) }
				}
			} finally {
				host.state.update { it.copy(containerOpsInFlight = it.containerOpsInFlight - target) }
			}
		}
	}
}
