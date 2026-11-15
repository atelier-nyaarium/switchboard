package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
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
	suspend fun list(gatewayId: String): ListAnswer<Runbook>
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

/** How a fire landed. */
internal sealed interface FireOutcome {
	data object Delivered : FireOutcome

	/** Queued until session starts. */
	data object Starting : FireOutcome

	/** Null: no answer or reason. */
	data class NotFired(val reason: String?) : FireOutcome
}

private const val FIRE_STARTING = "starting"

internal const val FIRES_ONCE_STARTED = "Runs once the session starts."

internal fun fireOutcome(answer: ConsoleRunbookFireResult?): FireOutcome = when {
	answer?.fired != true -> FireOutcome.NotFired(answer?.reason)
	answer.status == FIRE_STARTING -> FireOutcome.Starting
	else -> FireOutcome.Delivered
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

/** Named, not counted; unread is said. */
internal fun runbookDeleteLine(routines: GatewayList<com.atelier_nyaarium.switchboard.proto.RoutineState>, runbookId: String): String {
	val goes = "It goes from this Gateway and from this phone."
	return when (routines) {
		is GatewayList.Listed -> {
			val pinning = routines.rows.filter { it.routine.runbookId == runbookId }.map { it.routine.name }
			if (pinning.isEmpty()) goes
			else "It goes, and these routines stop running until you give them another: " + pinning.joinToString(", ")
		}
		GatewayList.NotServed -> goes
		GatewayList.Unread, GatewayList.Unreachable -> "$goes This Gateway's routines were not read; any that use it stop running."
	}
}

internal class RunbookOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: RunbookHost,
	private val provision: ProvisionFence,
) : ClearsOnReprovision {
	// Gateways are refreshed side by side, so these are touched from more than one coroutine at once.
	private val synced = java.util.concurrent.ConcurrentHashMap.newKeySet<Triple<String, String, Long>>()

	private val reads = GatewayReadFence()

	// Not saved instance state: a body outgrows a parcel.
	val edits = EditorSessions<EditKey, RunbookDraft, SaveRefusal>(
		unattended = { left -> tell(leftLine(left.draft.name, "Runbook", left.said?.reason.orEmpty())) },
	)

	private fun tell(message: String) = state.update { it.copy(transientMessages = it.transientMessages + message) }

	private fun owns(began: Long): Boolean = provision.isCurrent(began)

	/** Null once a re-provision began. */
	private fun <T> written(began: Long, write: () -> T): T? = provision.land(began, write)

	override suspend fun clearInMemory() {
		reads.clear()
		edits.clear()
		synced.clear()
		refusals.set(emptyMap())
	}

	suspend fun commit(key: EditKey, opening: Long, overwrite: Boolean) = edits.send(key, opening) { draft ->
		val candidate = draft.toRunbook() ?: return@send EditOutcome.Stays(SaveRefusal("Not a complete runbook", 0L))
		val saved = save(candidate, key.gatewayId, draft.revision.takeIf { it > 0L }, overwrite)
		if (saved is RunbookSaved.Refused) EditOutcome.Stays(saved.refusal) else EditOutcome.Done
	}

	// Closing on one this Gateway never took would say gone about a held copy.
	suspend fun remove(key: EditKey, opening: Long) = edits.send(key, opening) { draft ->
		if (delete(draft.id, key.gatewayId)) EditOutcome.Done
		else EditOutcome.Stays(SaveRefusal("This Gateway still holds it; it was not reached", 0L))
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
		refreshEach(state.value.gateways.ids(), ::refresh)
	}

	suspend fun refresh(gatewayId: String) {
		if (gatewayId.isBlank()) return
		val client = host.gateway
		val began = provision.capture()
		// One gateway's failure, whatever raised it, must not take down the pass around it.
		attempt {
			val answer = reads.list(TAG, gatewayId, client?.let { held -> suspend { held.list(gatewayId) } }) ?: return@attempt
			when (answer) {
				is ListAnswer.Listed -> written(began) {
					// Only this gateway's markers clear.
					synced.removeAll { it.first == gatewayId }
					show(gatewayId, host.library.merge(gatewayId, answer.rows))
				}
				ListAnswer.NotServed, ListAnswer.Unreachable -> missed(gatewayId, answer)
			}
		}
	}

	suspend fun save(
		runbook: Runbook,
		gatewayId: String,
		baseRevision: Long? = null,
		overwrite: Boolean = false,
	): RunbookSaved {
		val began = provision.capture()
		synced.removeAll { it.first == gatewayId && it.second == runbook.id }
		val client = host.gateway
		val reachable = client != null && gatewayId.isNotBlank()

		val answer = if (reachable) put(began, client as RunbookGateway, gatewayId, runbook, baseRevision, overwrite) else null
		if (!owns(began)) return RunbookSaved.Refused(SaveRefusal(REPROVISIONED, 0L))
		if (answer != null && !answer.stored) return RunbookSaved.Refused(gatewayRefusal(answer))

		// The gateway names the revision, so what it answers with is what the library takes.
		val landed = answer?.runbook
		if (landed != null) {
			written(began) {
				show(gatewayId, host.library.adopt(gatewayId, landed))
				synced += Triple(gatewayId, landed.id, landed.revision)
			} ?: return RunbookSaved.Refused(SaveRefusal(REPROVISIONED, 0L))
			return RunbookSaved.Stored
		}
		val kept = written(began) { keep(gatewayId, runbook) } ?: return RunbookSaved.Refused(libraryRefusal(gatewayId, runbook))
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
		val began = provision.capture()
		val answer = attempt { client.delete(gatewayId, runbookId) }
		if (answer?.deleted != true) return false
		return written(began) { forget(gatewayId, runbookId) } != null
	}

	private fun forget(gatewayId: String, runbookId: String) {
		synced.removeAll { it.first == gatewayId && it.second == runbookId }
		refusals.updateAndGet { it - (gatewayId to runbookId) }
		show(gatewayId, host.library.remove(gatewayId, runbookId))
	}

	/** Unplaced reads failed; placed stays. */
	private fun missed(gatewayId: String, answer: ListAnswer<Runbook>) {
		state.update { held ->
			held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(runbooks = it.runbooks.after(answer)) })
		}
	}

	/** Gateway copy, replaced whole. */
	private fun show(gatewayId: String, library: List<Runbook>) {
		state.update { held ->
			held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(runbooks = GatewayList.Listed(library)) })
		}
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
		val began = provision.capture()
		val mine = host.library.find(gatewayId, runbookId) ?: return false
		if (Triple(gatewayId, runbookId, mine.revision) in synced) return true

		// Fenced like every other per-gateway read; this one writes through show() too.
		// False: not confirmed.
		val theirs = when (val answer = reads.list(TAG, gatewayId) { client.list(gatewayId) }) {
			is ListAnswer.Listed -> answer.rows
			ListAnswer.NotServed, ListAnswer.Unreachable, null -> return false
		}
		val held = theirs.find { it.id == runbookId }
		var settledRevision = mine.revision
		val settled = when (val decision = pushDecision(mine, held)) {
			PushDecision.Ready -> true
			is PushDecision.Adopt -> {
				settledRevision = decision.theirs.revision
				written(began) { show(gatewayId, host.library.merge(gatewayId, listOf(decision.theirs))) } != null
			}
			// Not if deleted meanwhile.
			PushDecision.Put -> {
				val answer = if (host.library.find(gatewayId, runbookId) == null) null else {
					put(began, client, gatewayId, mine, held?.revision)
				}
				val adopted = answer?.runbook
				if (adopted != null) {
					settledRevision = adopted.revision
					written(began) { show(gatewayId, host.library.adopt(gatewayId, adopted)) } ?: return false
				}
				answer?.stored == true && owns(began)
			}
		}
		if (settled) synced += Triple(gatewayId, runbookId, settledRevision)
		return settled
	}

	private suspend fun put(
		began: Long,
		client: RunbookGateway,
		gatewayId: String,
		mine: Runbook,
		baseRevision: Long? = null,
		overwrite: Boolean = false,
	): ConsoleRunbookPutResult? {
		val answer = attempt { client.put(gatewayId, mine, baseRevision, overwrite) }
		if (owns(began)) refusals.updateAndGet { refusalsAfterPut(it, gatewayId to mine.id, answer) }
		return answer
	}

	/** Owner-authorized replacement. */
	suspend fun overwrite(runbookId: String, gatewayId: String): Boolean {
		val client = host.gateway ?: return false
		if (gatewayId.isBlank()) return false
		val began = provision.capture()
		val mine = host.library.find(gatewayId, runbookId) ?: return false
		val answer = put(began, client, gatewayId, mine, overwrite = true)
		if (answer?.stored != true) return false
		return written(began) {
			answer.runbook?.let { show(gatewayId, host.library.adopt(gatewayId, it)) }
			synced += Triple(gatewayId, runbookId, answer.revision)
		} != null
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Runbook"
		const val REPROVISIONED = "This phone was set up again"
	}
}
