package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapPutResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** The Router's two bootstrap owner ops. Null is no answer. */
internal interface EnrollRouter {
	suspend fun held(pickupId: String): Boolean?

	suspend fun put(pickupId: String, gatewaySignPub: String, frame: GatewayBootstrapFrame): GatewayBootstrapPutResult?
}

/** The unfinished Gateway setups this phone holds, and the pass that retires or re-hands each. */
internal class PendingEnrollOps(
	load: () -> String?,
	private val save: (String) -> Unit,
	private val router: EnrollRouter,
	private val registry: () -> GatewayRegistry,
	/** Whether the owner's keyring admits a Gateway signing key. */
	private val member: (String) -> Boolean,
	private val now: () -> Long = System::currentTimeMillis,
) : ClearsOnReprovision {
	private data class Due(val checks: Int, val at: Long)

	private val lock = Any()
	private val records = MutableStateFlow(decodePendingEnrolls(load()))

	// Never persisted: a restart checks at once.
	private val schedule = HashMap<String, Due>()

	val pending: StateFlow<Map<String, PendingEnroll>> = records

	fun note(record: PendingEnroll) = write { it + (record.gatewayId to record) }

	private fun clear(gatewayId: String) = write { it - gatewayId }

	// Disk first.
	private fun write(change: (Map<String, PendingEnroll>) -> Map<String, PendingEnroll>) = synchronized(lock) {
		val next = change(records.value)
		if (next != records.value) {
			save(encodePendingEnrolls(next))
			records.value = next
			schedule.keys.retainAll(next.keys)
		}
	}

	/** Null when the Router did not answer. */
	suspend fun handIn(record: PendingEnroll): GatewayBootstrapPutResult? {
		val frame = runIsolated { wireJson.decodeFromString(GatewayBootstrapFrame.serializer(), record.bundle) }.getOrNull()
			?: return null
		val result = router.put(record.pickupId, record.gatewaySignPub, frame)
		if (result?.held == false) DebugLog.log("Enroll", "hand-in refused for ${record.gatewayId}: ${result.refusal}")
		return result
	}

	/** One pass: retire what registered or was revoked, and hand in again what the Router does not hold. */
	suspend fun tick() {
		for ((gatewayId, record) in records.value) {
			val due = synchronized(lock) { schedule[gatewayId] }
			when (pendingStep(record, registry().entry(gatewayId), member(record.gatewaySignPub), now(), due?.at ?: 0L)) {
				PendingStep.RETIRE -> clear(gatewayId)
				PendingStep.WAIT -> Unit
				PendingStep.CHECK -> {
					if (router.held(record.pickupId) == false) handIn(record)
					val checks = due?.checks ?: 0
					synchronized(lock) {
						if (gatewayId in records.value) schedule[gatewayId] = Due(checks + 1, now() + enrollCheckDelay(checks))
					}
				}
			}
		}
	}

	override suspend fun clearInMemory() = synchronized(lock) {
		records.value = emptyMap()
		schedule.clear()
	}
}
