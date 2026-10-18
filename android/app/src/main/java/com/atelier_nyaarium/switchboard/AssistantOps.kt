package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** The Gateway's mark on the assistant's presence row. */
internal const val ASSISTANT_ROLE = "assistant"

/** The gateway calls this class makes, so a test can answer them without a transport. */
internal interface AssistantGateway {
	suspend fun call(gatewayId: String, op: ConsoleOp): AssistantAnswer
}

internal interface AssistantHost {
	val gateway: AssistantGateway?
}

/** What a move did. Placing comes first, so a refused place leaves the old home untouched. */
internal sealed interface AssistantMoved {
	data object Moved : AssistantMoved
	data class Refused(val reason: String) : AssistantMoved
	data object Unreachable : AssistantMoved

	/** Placed, but these Gateways it left did not release. */
	data class StillOn(val gatewayIds: List<String>) : AssistantMoved
}

/** The folder as the Gateway stores it: no trailing slash, the root kept. */
internal fun folderOf(text: String): String = text.trim().trimEnd('/').ifEmpty { "/" }

/** A move does something: another Gateway, or another folder on the same one. */
internal fun placementMoves(home: String?, target: String?, folder: String, workdir: String?): Boolean =
	target != null && (target != home || workdir == null || folderOf(folder) != folderOf(workdir))

/** Grant or release status; null when it landed. */
internal fun answerText(answer: AssistantAnswer): String? = when (answer) {
	is AssistantAnswer.State -> null
	is AssistantAnswer.Refused -> answer.reason
	AssistantAnswer.Unreachable -> "That Gateway could not be reached"
}

/** Move status; null when it landed. */
internal fun movedText(moved: AssistantMoved): String? = when (moved) {
	AssistantMoved.Moved -> null
	is AssistantMoved.Refused -> moved.reason
	AssistantMoved.Unreachable -> "That Gateway could not be reached"
	is AssistantMoved.StillOn ->
		"Placed, but ${moved.gatewayIds.joinToString()} did not confirm it let go. Move again once it answers."
}

/** One chip in the inbox strip. */
internal data class WatcherChip(val text: String, val needsSecret: Boolean)

internal fun watcherChip(watcher: AssistantWatcher): WatcherChip = when {
	watcher.grants.isEmpty() -> WatcherChip("${watcher.label} needs a secret", needsSecret = true)
	watcher.stopped != null -> WatcherChip("${watcher.label} stopped", needsSecret = false)
	else -> WatcherChip("${watcher.label} · ${watcher.unread} in inbox", needsSecret = false)
}

/** A watcher's settings row, under its name. */
internal fun watcherHealth(watcher: AssistantWatcher, ago: (Long) -> String): String {
	val status = when {
		watcher.stopped != null -> "Stopped: ${watcher.stopped}"
		watcher.backoff != null -> "Waiting: ${watcher.backoff.reason}"
		watcher.lastSuccessAt != null -> "Checked ${ago(watcher.lastSuccessAt)}"
		else -> "Not checked yet"
	}
	return if (watcher.evicted > 0) "$status · ${watcher.evicted} lost unread" else status
}

/** A stopped watcher that holds its secret can be asked again, as after a rotated key. */
internal fun canRetry(watcher: AssistantWatcher): Boolean = watcher.stopped != null && watcher.grants.isNotEmpty()

/** The assistant's conversation on a Gateway: its marked row, or the address the Gateway mints. */
internal fun assistantAddress(teams: List<Team>, domainId: String?, gatewayId: String): String? =
	teams.firstOrNull { it.role == ASSISTANT_ROLE && it.gatewayId == gatewayId }?.name
		?: domainId?.let { runIsolated { Address.of(it, gatewayId, "host", "assistant").canonical }.getOrNull() }

/** Nothing is held on the phone; every answer replaces what a Gateway last said. */
internal class AssistantOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: AssistantHost,
) {
	private val reads = GatewayReadFence()

	suspend fun refreshAll() {
		coroutineScope { state.value.gateways.ids().map { id -> async { refresh(id) } }.awaitAll() }
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val read = reads.read(gatewayId) { attempt { client.call(gatewayId, ConsoleOp.AssistantState) } }
		when (val answer = (read as? GatewayRead.Fresh)?.value) {
			is AssistantAnswer.State -> show(gatewayId, answer.state)
			// An older build refuses an op it does not know, and holds no assistant.
			is AssistantAnswer.Refused -> show(gatewayId, null)
			AssistantAnswer.Unreachable, null -> {}
		}
	}

	/**
	 * Asks every Gateway itself, never the drawn copy, so a home not yet drawn is still released. Then
	 * places, then releases. One that could not be asked may still hold it, so it is named with the
	 * ones that did not let go.
	 */
	suspend fun move(target: String, workdir: String): AssistantMoved {
		val client = host.gateway ?: return AssistantMoved.Unreachable
		val others = coroutineScope {
			state.value.gateways.ids().filter { it != target }.map { id ->
				async { id to (attempt { client.call(id, ConsoleOp.AssistantState) } ?: AssistantAnswer.Unreachable) }
			}.awaitAll()
		}
		val leaving = others.filter { (_, answer) -> (answer as? AssistantAnswer.State)?.state?.workdir != null }.map { it.first }
		val unread = others.filter { (_, answer) -> answer is AssistantAnswer.Unreachable }.map { it.first }
		when (val placed = landed(target, ConsoleOp.AssistantPlace(workdir = workdir))) {
			is AssistantAnswer.State -> {}
			is AssistantAnswer.Refused -> return AssistantMoved.Refused(placed.reason)
			AssistantAnswer.Unreachable -> return AssistantMoved.Unreachable
		}
		val stuck = (leaving.filter { release(it) !is AssistantAnswer.State } + unread).distinct()
		return if (stuck.isEmpty()) AssistantMoved.Moved else AssistantMoved.StillOn(stuck)
	}

	suspend fun release(gatewayId: String): AssistantAnswer = landed(gatewayId, ConsoleOp.AssistantRelease)

	suspend fun setGrants(gatewayId: String, watcherId: String, entryIds: List<String>): AssistantAnswer =
		landed(gatewayId, ConsoleOp.AssistantWatcherGrants(watcherId = watcherId, entryIds = entryIds))

	/** The same set again, which the Gateway reads as a poll now. */
	suspend fun retry(gatewayId: String, watcher: AssistantWatcher): AssistantAnswer =
		setGrants(gatewayId, watcher.id, watcher.grants)

	/** A change is drawn only by the fenced read after it, so no older answer lands over a newer one. */
	private suspend fun landed(gatewayId: String, op: ConsoleOp): AssistantAnswer {
		val client = host.gateway ?: return AssistantAnswer.Unreachable
		val answer = attempt { client.call(gatewayId, op) } ?: AssistantAnswer.Unreachable
		if (answer is AssistantAnswer.State) refresh(gatewayId)
		return answer
	}

	private fun show(gatewayId: String, answer: ConsoleAssistantStateResult?) {
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(assistant = answer) }) }
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (e: CancellationException) {
		throw e
	} catch (e: Exception) {
		DebugLog.log("Assistant", "gateway call failed: ${e.message}")
		null
	}
}
