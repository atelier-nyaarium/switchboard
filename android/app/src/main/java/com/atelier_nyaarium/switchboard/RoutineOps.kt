package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface RoutineGateway {
	suspend fun list(gatewayId: String): ConsoleRoutineListResult

	suspend fun put(gatewayId: String, routine: Routine, baseRevision: Long?): ConsoleRoutinePutResult

	/** What a candidate would next run at. The gateway owns recurrence; the phone holds none. */
	suspend fun next(gatewayId: String, routine: Routine): ConsoleRoutineNextResult

	suspend fun delete(gatewayId: String, routineId: String)

	suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean): ConsoleRoutinePutResult

	suspend fun runNow(gatewayId: String, routineId: String, occurrenceId: String): ConsoleRoutineOccurrenceResult

	suspend fun dismiss(gatewayId: String, routineId: String, occurrenceId: String): ConsoleRoutineOccurrenceResult
}

internal interface RoutineHost {
	val gateway: RoutineGateway?
	fun homeGatewayId(): String

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
	private var drafts = mapOf<String, Routine>()

	fun draftFor(key: String): Routine? = drafts[key]

	fun keepDraft(key: String, draft: Routine) {
		drafts = drafts + (key to draft)
	}

	fun dropDraft(key: String) {
		drafts = drafts - key
	}

	suspend fun refresh(gatewayId: String = host.homeGatewayId()) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val held = attempt { client.list(gatewayId) } ?: return
		show(gatewayId, held.routines, held.zone)
		host.onRoutinesChanged()
	}

	/** Carries the revision the editor was opened at; the gateway names the one it stores. */
	suspend fun save(
		routine: Routine,
		baseRevision: Long?,
		gatewayId: String = host.homeGatewayId(),
	): RoutineSaved {
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
	suspend fun nextRun(routine: Routine, gatewayId: String = host.homeGatewayId()): Long? {
		val client = host.gateway ?: return null
		if (gatewayId.isBlank()) return null
		return attempt { client.next(gatewayId, routine) }?.nextAt
	}

	suspend fun setEnabled(routineId: String, enabled: Boolean, gatewayId: String = host.homeGatewayId()): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val answer = attempt { client.enable(gatewayId, routineId, enabled) }
		refresh(gatewayId)
		return answer?.stored == true
	}

	/** False when this Gateway was not reached, so nothing says gone about a routine it still runs. */
	suspend fun delete(routineId: String, gatewayId: String = host.homeGatewayId()): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val took = attempt { client.delete(gatewayId, routineId) } != null
		refresh(gatewayId)
		return took
	}

	suspend fun runNow(routineId: String, occurrenceId: String, gatewayId: String = host.homeGatewayId()): Boolean =
		occurrence(gatewayId) { client -> client.runNow(gatewayId, routineId, occurrenceId) }

	suspend fun dismiss(routineId: String, occurrenceId: String, gatewayId: String = host.homeGatewayId()): Boolean =
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

	/** The tab draws the home gateway's routines; another gateway's are its own to run. */
	private fun show(gatewayId: String, routines: List<RoutineState>, zone: String) {
		if (gatewayId != host.homeGatewayId()) return
		state.update { it.copy(routines = routines, routineZone = zone) }
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
