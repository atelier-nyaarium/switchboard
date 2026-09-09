package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineRunResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface RoutineGateway {
	suspend fun list(gatewayId: String): ConsoleRoutineListResult

	suspend fun put(gatewayId: String, routine: Routine, baseRevision: Long?): ConsoleRoutinePutResult

	/** What a candidate would next run at. The gateway owns recurrence; the phone holds none. */
	suspend fun next(gatewayId: String, routine: Routine): ConsoleRoutineNextResult

	suspend fun delete(gatewayId: String, routineId: String): ConsoleRoutineDeleteResult

	suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean): ConsoleRoutinePutResult

	suspend fun runNow(gatewayId: String, routineId: String, occurrenceId: String): ConsoleRoutineOccurrenceResult

	/** A fresh run at the gateway's own `now`, which is why it names no occurrence. */
	suspend fun run(gatewayId: String, routineId: String): ConsoleRoutineRunResult

	suspend fun dismiss(gatewayId: String, routineId: String, occurrenceId: String): ConsoleRoutineOccurrenceResult
}

internal interface RoutineHost {
	val gateway: RoutineGateway?

	/** What the gateway now says, so the shade is reconciled against it rather than against a poll. */
	fun onRoutinesChanged() {}
}

/**
 * Nothing is held on the phone. A routine's record, its next run, its misses and its reviews are all
 * the gateway's, so every screen draws the last list and a change re-reads rather than guessing.
 */
internal sealed interface RoutineSaved {
	data class Stored(val routine: Routine) : RoutineSaved
	data class Refused(val reason: String, val heldRevision: Long) : RoutineSaved
	data object Unreachable : RoutineSaved
}

internal class RoutineOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RoutineHost,
) {
	private val drafts = java.util.concurrent.ConcurrentHashMap<Pair<String, String>, Routine>()

	private val reads = GatewayReadFence()

	fun draftFor(gatewayId: String, key: String): Routine? = drafts[gatewayId to key]

	fun keepDraft(gatewayId: String, key: String, draft: Routine) {
		drafts[gatewayId to key] = draft
	}

	fun dropDraft(gatewayId: String, key: String) {
		drafts.remove(gatewayId to key)
	}

	/** Every gateway the keyring admits, asked together so a slow one does not hold up the rest. */
	suspend fun refreshAll(gatewayIds: List<String>) {
		coroutineScope { gatewayIds.map { id -> async { refresh(id) } }.awaitAll() }
		// Membership as it stands now, not as this pass captured it.
		state.update { held ->
			val admitted = held.admittedGateways.toSet()
			held.copy(routines = held.routines.filter { it.gatewayId in admitted })
		}
		host.onRoutinesChanged()
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		// One gateway's failure, whatever raised it, must not take down the pass around it.
		attempt {
			val held = reads.read(gatewayId) { attempt { client.list(gatewayId) } } ?: return@attempt
			show(gatewayId, held.routines, held.zone)
			host.onRoutinesChanged()
		}
	}

	/** Carries the revision the editor was opened at; the gateway names the one it stores. */
	suspend fun save(routine: Routine, baseRevision: Long?, gatewayId: String): RoutineSaved {
		val client = host.gateway ?: return RoutineSaved.Unreachable
		if (gatewayId.isBlank()) return RoutineSaved.Unreachable
		val answer = attempt { client.put(gatewayId, routine, baseRevision) } ?: return RoutineSaved.Unreachable
		refresh(gatewayId)
		val stored = answer.routine
		if (!answer.stored || stored == null) {
			return RoutineSaved.Refused(answer.reason ?: "This Gateway holds a different copy", answer.revision)
		}
		return RoutineSaved.Stored(stored)
	}

	/** Null when nothing further is named, or when this Gateway could not be asked. */
	suspend fun nextRun(routine: Routine, gatewayId: String): Long? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.next(gatewayId, routine) }?.nextAt
	}

	suspend fun setEnabled(routineId: String, enabled: Boolean, gatewayId: String): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val answer = attempt { client.enable(gatewayId, routineId, enabled) }
		refresh(gatewayId)
		return answer?.stored == true
	}

	/** The gateway's own answer, so nothing says gone about a routine it still runs. */
	suspend fun delete(routineId: String, gatewayId: String): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val answer = attempt { client.delete(gatewayId, routineId) }
		refresh(gatewayId)
		return answer?.deleted == true
	}

	suspend fun runNow(routineId: String, occurrenceId: String, gatewayId: String): Boolean =
		occurrence(gatewayId) { client -> client.runNow(gatewayId, routineId, occurrenceId) }

	/** A fresh run, pressed. Not the schedule firing, so a disabled routine still takes one. */
	suspend fun run(routineId: String, gatewayId: String): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val answer = attempt { client.run(gatewayId, routineId) }
		refresh(gatewayId)
		return answer?.ran == true
	}

	suspend fun dismiss(routineId: String, occurrenceId: String, gatewayId: String): Boolean =
		occurrence(gatewayId) { client -> client.dismiss(gatewayId, routineId, occurrenceId) }

	private suspend fun occurrence(
		gatewayId: String,
		call: suspend (RoutineGateway) -> ConsoleRoutineOccurrenceResult,
	): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val answer = attempt { call(client) }
		refresh(gatewayId)
		return answer?.applied == true
	}

	/** That gateway's group, replaced whole. Sorted by id, so no gateway holds a privileged place. */
	private fun show(gatewayId: String, routines: List<RoutineState>, zone: String) {
		state.update { held ->
			val kept = held.routines.filterNot { it.gatewayId == gatewayId }
			held.copy(routines = (kept + GatewayRoutines(gatewayId, routines, zone)).sortedBy { it.gatewayId })
		}
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (e: CancellationException) {
		throw e
	} catch (e: Exception) {
		DebugLog.log("Routine", "gateway call failed: ${e.message}")
		null
	}
}
