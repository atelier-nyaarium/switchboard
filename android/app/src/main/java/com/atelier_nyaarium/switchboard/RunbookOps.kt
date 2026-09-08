package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.runbooks.RunbookManager
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

internal interface RunbookHost {
	val client: ConsoleClient?
	fun homeGatewayId(): String
	val library: RunbookManager
}

internal sealed interface PushDecision {
	data object Ready : PushDecision
	data object Put : PushDecision
	data class Adopt(val theirs: Runbook) : PushDecision
}

internal fun pushDecision(mine: Runbook, held: Runbook?): PushDecision = when {
	held == null -> PushDecision.Put
	held.revision > mine.revision -> PushDecision.Adopt(held)
	held.revision < mine.revision -> PushDecision.Put
	held == mine -> PushDecision.Ready
	else -> PushDecision.Put
}

internal data class RunbookConflict(val reason: String, val heldRevision: Long)

internal fun conflictOfRefusal(answer: ConsoleRunbookPutResult): RunbookConflict =
	RunbookConflict(answer.reason ?: "This Gateway holds a different copy", answer.revision)

internal fun conflictsAfterPut(
	held: Map<String, RunbookConflict>,
	runbookId: String,
	answer: ConsoleRunbookPutResult?,
): Map<String, RunbookConflict> = when {
	answer == null -> held
	answer.stored -> held - runbookId
	else -> held + (runbookId to conflictOfRefusal(answer))
}

/** Equal still conflicts. */
internal fun standingConflict(conflict: RunbookConflict?, draftRevision: Long): RunbookConflict? =
	conflict?.takeIf { it.heldRevision >= draftRevision }


internal sealed interface RunbookSaved {
	data object Stored : RunbookSaved
	data object Local : RunbookSaved
	data class Refused(val conflict: RunbookConflict) : RunbookSaved
}

internal class RunbookOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RunbookHost,
) {
	private val synced = mutableSetOf<Triple<String, String, Long>>()

	private var conflicts = emptyMap<String, RunbookConflict>()

	fun conflictOf(runbookId: String): RunbookConflict? = conflicts[runbookId]

	init {
		show(host.library.all())
	}

	suspend fun refresh(gatewayId: String = host.homeGatewayId()) {
		val client = host.client ?: return
		if (gatewayId.isBlank()) return
		val held = attempt { client.runbookList(gatewayId) } ?: return
		synced.clear()
		show(host.library.merge(held.runbooks))
	}

	suspend fun save(
		runbook: Runbook,
		gatewayId: String = host.homeGatewayId(),
		baseRevision: Long? = null,
		overwrite: Boolean = false,
	): RunbookSaved {
		synced.removeAll { it.second == runbook.id }
		val client = host.client
		val reachable = client != null && gatewayId.isNotBlank()

		val answer = if (reachable) put(client as ConsoleClient, gatewayId, runbook, baseRevision, overwrite) else null
		if (answer != null && !answer.stored) return RunbookSaved.Refused(conflictOfRefusal(answer))

		// The gateway names the revision, so what it answers with is what the library takes.
		val landed = answer?.runbook ?: runbook
		val kept = keep(landed) ?: return RunbookSaved.Refused(localConflict(landed))
		if (answer != null) synced += Triple(gatewayId, landed.id, kept.revision)
		return if (answer != null) RunbookSaved.Stored else RunbookSaved.Local
	}

	private fun keep(runbook: Runbook): Runbook? {
		val library = host.library.merge(listOf(runbook))
		show(library)
		return library.find { it.id == runbook.id }?.takeIf { it == runbook }
	}

	private fun localConflict(runbook: Runbook): RunbookConflict {
		val landed = host.library.find(runbook.id)
		val outranked = landed != null && landed.revision >= runbook.revision
		val reason = if (outranked) "This phone holds a newer copy" else "This phone could not store it"
		return RunbookConflict(reason, landed?.revision ?: 0L)
	}

	suspend fun delete(runbookId: String, gatewayId: String = host.homeGatewayId()) {
		synced.removeAll { it.second == runbookId }
		conflicts = conflicts - runbookId
		show(host.library.remove(runbookId))
		val client = host.client ?: return
		if (gatewayId.isNotBlank()) attempt { client.runbookDelete(gatewayId, runbookId) }
	}

	private fun show(library: List<Runbook>) {
		state.update { it.copy(runbooks = library) }
	}

	suspend fun preview(
		runbookId: String,
		values: Map<String, String>,
		gatewayId: String = host.homeGatewayId(),
	): ConsoleRunbookPreviewResult? {
		val client = host.client ?: return null
		if (!sync(runbookId, gatewayId)) return null
		return attempt { client.runbookPreview(gatewayId, runbookId, values) }
	}

	suspend fun fire(
		runbookId: String,
		values: Map<String, String>,
		into: RunbookFireTarget,
		previewedRevision: Long?,
		gatewayId: String = host.homeGatewayId(),
	): ConsoleRunbookFireResult? {
		val client = host.client ?: return null
		if (!sync(runbookId, gatewayId)) return null
		return try {
			client.runbookFire(gatewayId, runbookId, values, into, previewedRevision)
		} catch (cancelled: CancellationException) {
			throw cancelled
		} catch (refused: Exception) {
			ConsoleRunbookFireResult(fired = false, reason = refused.message ?: "the Gateway refused this fire")
		}
	}

	private suspend fun sync(runbookId: String, gatewayId: String): Boolean {
		val client = host.client ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(runbookId) ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		val theirs = attempt { client.runbookList(gatewayId) } ?: return false
		val held = theirs.runbooks.find { it.id == runbookId }
		var settledRevision = mine.revision
		val settled = when (val decision = pushDecision(mine, held)) {
			PushDecision.Ready -> true
			is PushDecision.Adopt -> {
				settledRevision = decision.theirs.revision
				show(host.library.merge(listOf(decision.theirs)))
				true
			}
			// Not if deleted meanwhile.
			PushDecision.Put -> {
				val answer = if (host.library.find(runbookId) == null) null else {
					put(client, gatewayId, mine, held?.revision)
				}
				answer?.runbook?.let { settledRevision = it.revision }
				answer?.stored == true
			}
		}
		if (settled) synced += Triple(gatewayId, runbookId, settledRevision)
		return settled
	}

	private suspend fun put(
		client: ConsoleClient,
		gatewayId: String,
		mine: Runbook,
		baseRevision: Long? = null,
		overwrite: Boolean = false,
	): ConsoleRunbookPutResult? {
		val answer = attempt { client.runbookPut(gatewayId, mine, baseRevision, overwrite) }
		conflicts = conflictsAfterPut(conflicts, mine.id, answer)
		return answer
	}

	/** Owner-authorized replacement. */
	suspend fun overwrite(runbookId: String, gatewayId: String = host.homeGatewayId()): Boolean {
		val client = host.client ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(runbookId) ?: return false
		val answer = put(client, gatewayId, mine, overwrite = true)
		if (answer?.stored != true) return false
		answer.runbook?.let { show(host.library.merge(listOf(it))) }
		synced += Triple(gatewayId, runbookId, answer.revision)
		return true
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (cancelled: CancellationException) {
		throw cancelled
	} catch (_: Exception) {
		null
	}
}
