package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineRunResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.routines.RoutineDraft
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface RoutineGateway {
	suspend fun list(gatewayId: String): ListAnswer<RoutineState>

	suspend fun put(gatewayId: String, routine: Routine, baseRevision: Long?): ConsoleRoutinePutResult

	/** What a candidate would next run at. The gateway owns recurrence; the phone holds none. */
	suspend fun next(gatewayId: String, routine: Routine): ConsoleRoutineNextResult

	suspend fun delete(gatewayId: String, routineId: String): ConsoleRoutineDeleteResult

	/** Carries the row's revision; a stale toggle is refused. */
	suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean, baseRevision: Long): ConsoleRoutinePutResult

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
) : ClearsOnReprovision {
	val edits = EditorSessions<EditKey, RoutineDraft, SaveSaid>(
		unattended = { left -> tell(leftLine(left.draft.name, "Routine", left.said?.reason.orEmpty())) },
	)

	private fun tell(message: String) = state.update { it.withNotice(message) }

	private val reads = GatewayReadFence()

	val toggles = ToggleFence()

	override suspend fun clearInMemory() {
		reads.clear()
		toggles.clear()
		edits.clear()
	}

	suspend fun commit(key: EditKey, opening: Long, candidate: (RoutineDraft) -> Routine?) = edits.send(key, opening) { draft ->
		val routine = candidate(draft) ?: return@send EditOutcome.Stays(SaveSaid("Not a complete routine"))
		when (val saved = save(routine, draft.revision.takeIf { it > 0L }, key.gatewayId)) {
			is RoutineSaved.Stored -> EditOutcome.Done
			is RoutineSaved.Refused -> EditOutcome.Stays(SaveSaid(saved.reason, saved.heldRevision))
			RoutineSaved.Unreachable -> EditOutcome.Stays(SaveSaid(GATEWAY_UNREACHABLE))
		}
	}

	suspend fun remove(key: EditKey, opening: Long) = edits.send(key, opening) { draft ->
		if (delete(draft.id, key.gatewayId)) EditOutcome.Done
		else EditOutcome.Stays(SaveSaid("This Gateway still runs it; it was not reached"))
	}

	/** All roster Gateways, concurrently. */
	suspend fun refreshAll() {
		refreshEach(state.value.gateways.ids(), ::refresh)
		host.onRoutinesChanged()
	}

	suspend fun refresh(gatewayId: String) {
		if (gatewayId.isBlank()) return
		val client = host.gateway
		// One gateway's failure, whatever raised it, must not take down the pass around it.
		attempt {
			val answer = reads.list(TAG, gatewayId, client?.let { held -> suspend { held.list(gatewayId) } }) ?: return@attempt
			state.update { held ->
				held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(routines = it.routines.after(answer)) })
			}
			if (answer != ListAnswer.Unreachable) host.onRoutinesChanged()
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

	suspend fun setEnabled(routineId: String, enabled: Boolean, baseRevision: Long, gatewayId: String): RoutineSaved {
		val client = host.gateway
		if (client == null || gatewayId.isBlank()) {
			toggles.note(gatewayId, routineId, GATEWAY_UNREACHABLE)
			return RoutineSaved.Unreachable
		}
		return toggles.run(gatewayId, routineId, ::toggleLine) {
			val answer = attempt { client.enable(gatewayId, routineId, enabled, baseRevision) }
			refresh(gatewayId)
			val stored = answer?.routine
			when {
				answer == null -> RoutineSaved.Unreachable
				!answer.stored || stored == null ->
					RoutineSaved.Refused(answer.reason ?: "This Gateway holds a different copy", answer.revision)
				else -> RoutineSaved.Stored(stored)
			}
		}
	}

	private fun toggleLine(saved: RoutineSaved): String? = when (saved) {
		is RoutineSaved.Stored -> null
		is RoutineSaved.Refused -> saved.reason
		RoutineSaved.Unreachable -> GATEWAY_UNREACHABLE
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

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Routine"
	}
}
