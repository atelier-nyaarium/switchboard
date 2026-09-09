package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.runbooks.RunbookDraft
import com.atelier_nyaarium.switchboard.runbooks.RunbookManager
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface RunbookGateway {
	suspend fun list(gatewayId: String): ConsoleRunbookListResult
	suspend fun put(
		gatewayId: String,
		runbook: Runbook,
		baseRevision: Long?,
		overwrite: Boolean,
	): ConsoleRunbookPutResult

	suspend fun delete(gatewayId: String, runbookId: String)
	suspend fun preview(
		gatewayId: String,
		runbookId: String,
		values: Map<String, String>,
	): ConsoleRunbookPreviewResult

	suspend fun fire(
		gatewayId: String,
		runbookId: String,
		values: Map<String, String>,
		into: RunbookFireTarget,
		previewedRevision: Long?,
	): ConsoleRunbookFireResult
}

internal interface RunbookHost {
	val gateway: RunbookGateway?
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

/** A save that was turned down, and the revision whoever turned it down holds. */
internal data class SaveRefusal(val reason: String, val heldRevision: Long)

internal fun gatewayRefusal(answer: ConsoleRunbookPutResult): SaveRefusal =
	SaveRefusal(answer.reason ?: "This Gateway holds a different copy", answer.revision)

internal fun refusalsAfterPut(
	held: Map<String, SaveRefusal>,
	runbookId: String,
	answer: ConsoleRunbookPutResult?,
): Map<String, SaveRefusal> = when {
	answer == null -> held
	answer.stored -> held - runbookId
	else -> held + (runbookId to gatewayRefusal(answer))
}

/** Equal still stands. */
internal fun standingRefusal(refusal: SaveRefusal?, draftRevision: Long): SaveRefusal? =
	refusal?.takeIf { it.heldRevision >= draftRevision }

/** One this save earned outranks one left standing from an earlier push. */
internal fun refusalToShow(thisSave: SaveRefusal?, standing: SaveRefusal?, draftRevision: Long): SaveRefusal? =
	thisSave ?: standingRefusal(standing, draftRevision)


internal sealed interface RunbookSaved {
	data object Stored : RunbookSaved
	data object Local : RunbookSaved
	data class Refused(val refusal: SaveRefusal) : RunbookSaved
}

internal class RunbookOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RunbookHost,
) {
	private val synced = mutableSetOf<Triple<String, String, Long>>()

	/**
	 * Editors in progress, keyed by the runbook being edited. This class outlives an activity, so a
	 * rotation finds the draft still here; saved instance state could not hold one, since a body is
	 * bounded by nothing and the parcel it would ride in is.
	 */
	private val drafts = mutableMapOf<String, RunbookDraft>()

	fun draftFor(key: String): RunbookDraft? = drafts[key]

	fun keepDraft(key: String, draft: RunbookDraft) {
		drafts[key] = draft
	}

	fun dropDraft(key: String) {
		drafts.remove(key)
	}

	private var refusals = emptyMap<String, SaveRefusal>()

	fun refusalFor(runbookId: String): SaveRefusal? = refusals[runbookId]

	init {
		show(host.library.all())
	}

	suspend fun refresh(gatewayId: String = host.homeGatewayId()) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val held = attempt { client.list(gatewayId) } ?: return
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
		val client = host.gateway
		val reachable = client != null && gatewayId.isNotBlank()

		val answer = if (reachable) put(client as RunbookGateway, gatewayId, runbook, baseRevision, overwrite) else null
		if (answer != null && !answer.stored) return RunbookSaved.Refused(gatewayRefusal(answer))

		// The gateway names the revision, so what it answers with is what the library takes.
		val landed = answer?.runbook
		if (landed != null) {
			show(host.library.adopt(landed))
			synced += Triple(gatewayId, landed.id, landed.revision)
			return RunbookSaved.Stored
		}
		val kept = keep(runbook) ?: return RunbookSaved.Refused(libraryRefusal(runbook))
		if (answer != null) synced += Triple(gatewayId, runbook.id, kept.revision)
		return if (answer != null) RunbookSaved.Stored else RunbookSaved.Local
	}

	private fun keep(runbook: Runbook): Runbook? {
		val library = host.library.merge(listOf(runbook))
		show(library)
		return library.find { it.id == runbook.id }?.takeIf { it == runbook }
	}

	private fun libraryRefusal(runbook: Runbook): SaveRefusal {
		val landed = host.library.find(runbook.id)
		val outranked = landed != null && landed.revision >= runbook.revision
		val reason = if (outranked) "This phone holds a newer copy" else "This phone could not store it"
		return SaveRefusal(reason, landed?.revision ?: 0L)
	}

	suspend fun delete(runbookId: String, gatewayId: String = host.homeGatewayId()) {
		synced.removeAll { it.second == runbookId }
		refusals = refusals - runbookId
		show(host.library.remove(runbookId))
		val client = host.gateway ?: return
		if (gatewayId.isNotBlank()) attempt { client.delete(gatewayId, runbookId) }
	}

	private fun show(library: List<Runbook>) {
		state.update { it.copy(runbooks = library) }
	}

	suspend fun preview(
		runbookId: String,
		values: Map<String, String>,
		gatewayId: String = host.homeGatewayId(),
	): ConsoleRunbookPreviewResult? {
		val client = host.gateway ?: return null
		if (!sync(runbookId, gatewayId)) return null
		return attempt { client.preview(gatewayId, runbookId, values) }
	}

	suspend fun fire(
		runbookId: String,
		values: Map<String, String>,
		into: RunbookFireTarget,
		previewedRevision: Long?,
		gatewayId: String = host.homeGatewayId(),
	): ConsoleRunbookFireResult? {
		val client = host.gateway ?: return null
		if (!sync(runbookId, gatewayId)) return null
		return try {
			client.fire(gatewayId, runbookId, values, into, previewedRevision)
		} catch (cancelled: CancellationException) {
			throw cancelled
		} catch (refused: Exception) {
			ConsoleRunbookFireResult(fired = false, reason = refused.message ?: "the Gateway refused this fire")
		}
	}

	private suspend fun sync(runbookId: String, gatewayId: String): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(runbookId) ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		val theirs = attempt { client.list(gatewayId) } ?: return false
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
				answer?.runbook?.let {
					settledRevision = it.revision
					show(host.library.adopt(it))
				}
				answer?.stored == true
			}
		}
		if (settled) synced += Triple(gatewayId, runbookId, settledRevision)
		return settled
	}

	private suspend fun put(
		client: RunbookGateway,
		gatewayId: String,
		mine: Runbook,
		baseRevision: Long? = null,
		overwrite: Boolean = false,
	): ConsoleRunbookPutResult? {
		val answer = attempt { client.put(gatewayId, mine, baseRevision, overwrite) }
		refusals = refusalsAfterPut(refusals, mine.id, answer)
		return answer
	}

	/** Owner-authorized replacement. */
	suspend fun overwrite(runbookId: String, gatewayId: String = host.homeGatewayId()): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(runbookId) ?: return false
		val answer = put(client, gatewayId, mine, overwrite = true)
		if (answer?.stored != true) return false
		answer.runbook?.let { show(host.library.adopt(it)) }
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
