package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.runbooks.RunbookDraft
import com.atelier_nyaarium.switchboard.runbooks.RunbookManager
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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

	suspend fun delete(gatewayId: String, runbookId: String): ConsoleRunbookDeleteResult
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
	held: Map<Pair<String, String>, SaveRefusal>,
	key: Pair<String, String>,
	answer: ConsoleRunbookPutResult?,
): Map<Pair<String, String>, SaveRefusal> = when {
	answer == null -> held
	answer.stored -> held - key
	else -> held + (key to gatewayRefusal(answer))
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
	// Gateways are refreshed side by side, so these are touched from more than one coroutine at once.
	private val synced = java.util.concurrent.ConcurrentHashMap.newKeySet<Triple<String, String, Long>>()

	private val reads = GatewayReadFence()

	/**
	 * Editors in progress, keyed by gateway and runbook. Held here rather than in saved instance
	 * state, since a body is bounded by nothing and the parcel it would ride in is.
	 */
	private val drafts = java.util.concurrent.ConcurrentHashMap<Pair<String, String>, RunbookDraft>()

	fun draftFor(gatewayId: String, key: String): RunbookDraft? = drafts[gatewayId to key]

	fun keepDraft(gatewayId: String, key: String, draft: RunbookDraft) {
		drafts[gatewayId to key] = draft
	}

	fun dropDraft(gatewayId: String, key: String) {
		drafts.remove(gatewayId to key)
	}

	// Read and written whole, so a fold from two gateways at once cannot drop one side's refusal.
	private val refusals = java.util.concurrent.atomic.AtomicReference(emptyMap<Pair<String, String>, SaveRefusal>())

	fun refusalFor(gatewayId: String, runbookId: String): SaveRefusal? = refusals.get()[gatewayId to runbookId]

	init {
		// Every gateway's stored copy, so a tab drawn before any refresh answers is not one gateway's.
		host.library.placed().forEach { (gatewayId, library) -> show(gatewayId, library) }
	}

	/** All roster Gateways, concurrently. */
	suspend fun refreshAll() {
		coroutineScope { state.value.gateways.ids().map { id -> async { refresh(id) } }.awaitAll() }
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		// One gateway's failure, whatever raised it, must not take down the pass around it.
		attempt {
			val read = reads.read(gatewayId) { attempt { client.list(gatewayId) } }
			val held = (read as? GatewayRead.Fresh)?.value ?: return@attempt
			// This gateway's markers only. Clearing every gateway's would push again for nothing.
			synced.removeAll { it.first == gatewayId }
			show(gatewayId, host.library.merge(gatewayId, held.runbooks))
		}
	}

	suspend fun save(
		runbook: Runbook,
		gatewayId: String,
		baseRevision: Long? = null,
		overwrite: Boolean = false,
	): RunbookSaved {
		synced.removeAll { it.first == gatewayId && it.second == runbook.id }
		val client = host.gateway
		val reachable = client != null && gatewayId.isNotBlank()

		val answer = if (reachable) put(client as RunbookGateway, gatewayId, runbook, baseRevision, overwrite) else null
		if (answer != null && !answer.stored) return RunbookSaved.Refused(gatewayRefusal(answer))

		// The gateway names the revision, so what it answers with is what the library takes.
		val landed = answer?.runbook
		if (landed != null) {
			show(gatewayId, host.library.adopt(gatewayId, landed))
			synced += Triple(gatewayId, landed.id, landed.revision)
			return RunbookSaved.Stored
		}
		val kept = keep(gatewayId, runbook) ?: return RunbookSaved.Refused(libraryRefusal(gatewayId, runbook))
		if (answer != null) synced += Triple(gatewayId, runbook.id, kept.revision)
		return if (answer != null) RunbookSaved.Stored else RunbookSaved.Local
	}

	private fun keep(gatewayId: String, runbook: Runbook): Runbook? {
		val library = host.library.merge(gatewayId, listOf(runbook))
		show(gatewayId, library)
		return library.find { it.id == runbook.id }?.takeIf { it == runbook }
	}

	private fun libraryRefusal(gatewayId: String, runbook: Runbook): SaveRefusal {
		val landed = host.library.find(gatewayId, runbook.id)
		val outranked = landed != null && landed.revision >= runbook.revision
		val reason = if (outranked) "This phone holds a newer copy" else "This phone could not store it"
		return SaveRefusal(reason, landed?.revision ?: 0L)
	}

	/** False when this Gateway still holds it, so the editor does not say gone about a copy that is not. */
	suspend fun delete(runbookId: String, gatewayId: String): Boolean {
		val client = host.gateway
		// No Gateway to disagree with, so this phone's copy is the only one it knows of and it goes.
		// A copy the Gateway still holds comes back on the next list, as an unsynced one always would.
		if (client == null || gatewayId.isBlank()) {
			forget(gatewayId, runbookId)
			return true
		}
		// Asked before the local copy goes. Removing first would hide a copy the Gateway still holds.
		val answer = attempt { client.delete(gatewayId, runbookId) }
		if (answer?.deleted != true) return false
		forget(gatewayId, runbookId)
		return true
	}

	private fun forget(gatewayId: String, runbookId: String) {
		synced.removeAll { it.first == gatewayId && it.second == runbookId }
		refusals.updateAndGet { it - (gatewayId to runbookId) }
		show(gatewayId, host.library.remove(gatewayId, runbookId))
	}

	/** Gateway copy, replaced whole. */
	private fun show(gatewayId: String, library: List<Runbook>) {
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(runbooks = library) }) }
	}

	suspend fun preview(
		runbookId: String,
		values: Map<String, String>,
		gatewayId: String,
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
		gatewayId: String,
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
		val mine = host.library.find(gatewayId, runbookId) ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		// Fenced like every other per-gateway read; this one writes through show() too.
		val read = reads.read(gatewayId) { attempt { client.list(gatewayId) } }
		val theirs = (read as? GatewayRead.Fresh)?.value ?: return false
		val held = theirs.runbooks.find { it.id == runbookId }
		var settledRevision = mine.revision
		val settled = when (val decision = pushDecision(mine, held)) {
			PushDecision.Ready -> true
			is PushDecision.Adopt -> {
				settledRevision = decision.theirs.revision
				show(gatewayId, host.library.merge(gatewayId, listOf(decision.theirs)))
				true
			}
			// Not if deleted meanwhile.
			PushDecision.Put -> {
				val answer = if (host.library.find(gatewayId, runbookId) == null) null else {
					put(client, gatewayId, mine, held?.revision)
				}
				answer?.runbook?.let {
					settledRevision = it.revision
					show(gatewayId, host.library.adopt(gatewayId, it))
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
		refusals.updateAndGet { refusalsAfterPut(it, gatewayId to mine.id, answer) }
		return answer
	}

	/** Owner-authorized replacement. */
	suspend fun overwrite(runbookId: String, gatewayId: String): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val mine = host.library.find(gatewayId, runbookId) ?: return false
		val answer = put(client, gatewayId, mine, overwrite = true)
		if (answer?.stored != true) return false
		answer.runbook?.let { show(gatewayId, host.library.adopt(gatewayId, it)) }
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
