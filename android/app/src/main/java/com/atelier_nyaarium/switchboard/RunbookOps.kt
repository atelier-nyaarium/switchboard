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

/** Equal revisions with different words are a lost update, which the gateway refuses. */
internal fun pushDecision(mine: Runbook, held: Runbook?): PushDecision = when {
	held == null -> PushDecision.Put
	held.revision > mine.revision -> PushDecision.Adopt(held)
	held.revision < mine.revision -> PushDecision.Put
	held == mine -> PushDecision.Ready
	else -> PushDecision.Put
}

/** The revision a save must clear to win. */
internal data class RunbookConflict(val reason: String, val heldRevision: Long)

internal fun conflictOfRefusal(answer: ConsoleRunbookPutResult): RunbookConflict =
	RunbookConflict(answer.reason ?: "This Gateway holds a different copy", answer.revision)

/** No answer leaves a standing conflict alone. */
internal fun conflictsAfterPut(
	held: Map<String, RunbookConflict>,
	runbookId: String,
	answer: ConsoleRunbookPutResult?,
): Map<String, RunbookConflict> = when {
	answer == null -> held
	answer.stored -> held - runbookId
	else -> held + (runbookId to conflictOfRefusal(answer))
}

/** Rebasing below the draft would mint a revision `merge` discards. */
internal fun standingConflict(conflict: RunbookConflict?, draftRevision: Long): RunbookConflict? =
	conflict?.takeIf { it.heldRevision >= draftRevision }

/** Refused keeps the editor open; the other two close it. */
internal sealed interface RunbookSaved {
	data object Stored : RunbookSaved
	/** No Gateway answered, so the copy is the phone's alone. */
	data object Local : RunbookSaved
	data class Refused(val conflict: RunbookConflict) : RunbookSaved
}

/** The gateway calls. `RunbookManager` owns the library itself. */
internal class RunbookOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RunbookHost,
) {
	/** One push per revision, so typing does not ask the gateway per keystroke. */
	private val synced = mutableSetOf<Triple<String, String, Long>>()

	private var conflicts = emptyMap<String, RunbookConflict>()

	fun conflictOf(runbookId: String): RunbookConflict? = conflicts[runbookId]

	init {
		show(host.library.all())
	}

	/** Adopts anything the gateway holds newer. */
	suspend fun refresh(gatewayId: String = host.homeGatewayId()) {
		val client = host.client ?: return
		if (gatewayId.isBlank()) return
		val held = attempt { client.runbookList(gatewayId) } ?: return
		// Just read, so nothing older is believable.
		synced.clear()
		show(host.library.merge(held.runbooks))
	}

	/** Pushed before it answers, so a refusal reaches the editor while the draft is open. */
	suspend fun save(runbook: Runbook, gatewayId: String = host.homeGatewayId()): RunbookSaved {
		synced.removeAll { it.second == runbook.id }
		val client = host.client
		val reachable = client != null && gatewayId.isNotBlank()

		// Refused before the library is touched, so a lost update never lands.
		val answer = if (reachable) put(client as ConsoleClient, gatewayId, runbook) else null
		if (answer != null && !answer.stored) return RunbookSaved.Refused(conflictOfRefusal(answer))

		val kept = keep(runbook) ?: return RunbookSaved.Refused(localConflict(runbook))
		if (answer != null) synced += Triple(gatewayId, runbook.id, kept.revision)
		return if (answer != null) RunbookSaved.Stored else RunbookSaved.Local
	}

	/** Null when the library did not take the save. */
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

	/** Pinned to the previewed revision, so a body edited since is refused. */
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
			// A bare null would throw the reason away.
			ConsoleRunbookFireResult(fired = false, reason = refused.message ?: "the Gateway refused this fire")
		}
	}

	private suspend fun sync(runbookId: String, gatewayId: String): Boolean {
		val client = host.client ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(runbookId) ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		val theirs = attempt { client.runbookList(gatewayId) } ?: return false
		// Settles the revision it checked, not whatever lands later.
		var settledRevision = mine.revision
		val settled = when (val decision = pushDecision(mine, theirs.runbooks.find { it.id == runbookId })) {
			PushDecision.Ready -> true
			is PushDecision.Adopt -> {
				settledRevision = decision.theirs.revision
				show(host.library.merge(listOf(decision.theirs)))
				true
			}
			// A delete in flight must not be undone by this put.
			PushDecision.Put ->
				host.library.find(runbookId) != null && put(client, gatewayId, mine)?.stored == true
		}
		if (settled) synced += Triple(gatewayId, runbookId, settledRevision)
		return settled
	}

	/** The one push. A refusal is an edit conflict, not an outage. */
	private suspend fun put(client: ConsoleClient, gatewayId: String, mine: Runbook): ConsoleRunbookPutResult? {
		val answer = attempt { client.runbookPut(gatewayId, mine) }
		conflicts = conflictsAfterPut(conflicts, mine.id, answer)
		return answer
	}

	/** A cancelled call stays cancelled. Only a real failure answers null. */
	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (cancelled: CancellationException) {
		throw cancelled
	} catch (_: Exception) {
		null
	}
}
