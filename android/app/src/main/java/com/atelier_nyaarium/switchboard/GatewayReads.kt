package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.decodeFromJsonElement

internal const val GATEWAY_UNREACHABLE = "This Gateway could not be reached."

internal suspend fun <T> gatewayAttempt(tag: String, call: suspend () -> T): T? = try {
	call()
} catch (e: CancellationException) {
	throw e
} catch (e: Exception) {
	DebugLog.log(tag, "gateway call failed: ${e::class.simpleName}")
	null
}

internal sealed interface ListAnswer<out T> {
	data class Listed<T>(val rows: List<T>) : ListAnswer<T>

	data object NotServed : ListAnswer<Nothing>

	data object Unreachable : ListAnswer<Nothing>
}

/** Only NOT_SERVED means unsupported. */
internal fun <T> listAnswerOf(
	answer: ConsoleClient.ValueAnswer,
	rows: (kotlinx.serialization.json.JsonElement) -> List<T>?,
): ListAnswer<T> = when (answer) {
	is ConsoleClient.ValueAnswer.Answered -> rows(answer.result)?.let { ListAnswer.Listed(it) } ?: ListAnswer.Unreachable
	is ConsoleClient.ValueAnswer.Refused ->
		if (answer.reason == com.atelier_nyaarium.switchboard.proto.Protocol.Wire.OP_REASON_NOT_SERVED) ListAnswer.NotServed else ListAnswer.Unreachable
	is ConsoleClient.ValueAnswer.Undelivered, ConsoleClient.ValueAnswer.Unreachable -> ListAnswer.Unreachable
}

internal suspend inline fun <reified R, T> ConsoleClient.listAnswer(
	gatewayId: String,
	op: ConsoleOp,
	crossinline rows: (R) -> List<T>,
): ListAnswer<T> = listAnswerOf(sendValueAnswer(gatewayId, op)) { result ->
	runIsolated { rows(wireJson.decodeFromJsonElement<R>(result)) }.getOrNull()
}

internal suspend fun refreshEach(gatewayIds: List<String>, refresh: suspend (String) -> Unit) {
	coroutineScope { gatewayIds.map { id -> async { refresh(id) } }.awaitAll() }
}

/** Silence keeps what was drawn. */
internal fun <T> GatewayList<T>.after(answer: ListAnswer<T>): GatewayList<T> = when (answer) {
	is ListAnswer.Listed -> GatewayList.Listed(answer.rows)
	ListAnswer.NotServed -> GatewayList.NotServed
	ListAnswer.Unreachable -> if (this == GatewayList.Unread) GatewayList.Unreachable else this
}

/** Null when a newer read owns it. */
internal suspend fun <T> GatewayReadFence.list(tag: String, gatewayId: String, call: (suspend () -> ListAnswer<T>)?): ListAnswer<T>? {
	if (call == null) return ListAnswer.Unreachable
	return when (val read = read(gatewayId) { gatewayAttempt(tag, call) ?: ListAnswer.Unreachable }) {
		is GatewayRead.Fresh -> read.value
		GatewayRead.Stale -> null
	}
}

/** What a fenced read answers: the body's value, or nothing because a newer read owns the key. */
internal sealed interface GatewayRead<out T> {
	data class Fresh<T>(val value: T) : GatewayRead<T>

	data object Stale : GatewayRead<Nothing>
}

/**
 * Which read of a gateway is the current one. An older answer landing after a newer one would put
 * back what the owner just settled. One counter per gateway, so a slow read of one never discards a
 * fresh read of another.
 */
internal class GatewayReadFence {
	private val counters = ConcurrentHashMap<String, AtomicLong>()

	private val generation = AtomicLong()

	/** Reads still out answer Stale. */
	fun clear() {
		generation.incrementAndGet()
	}

	/**
	 * Claims a read; the body's answer is Fresh only while no later claim of the key exists. The key is
	 * whatever the holder scopes by: a gateway id for the per-gateway tabs, a session address for windows.
	 */
	suspend fun <T> read(key: String, call: suspend () -> T): GatewayRead<T> {
		val began = generation.get()
		val counter = counters.computeIfAbsent(key) { AtomicLong(0) }
		val mine = counter.incrementAndGet()
		val value = call()
		return if (mine == counter.get() && began == generation.get()) GatewayRead.Fresh(value) else GatewayRead.Stale
	}
}

/** Per-row refusals; the newest toggle wins. */
internal class ToggleFence {
	private val fence = GatewayReadFence()

	val refusals = androidx.compose.runtime.mutableStateOf<Map<Pair<String, String>, String>>(emptyMap())

	fun refusalFor(gatewayId: String, id: String): String? = refusals.value[gatewayId to id]

	/** Null clears the line. */
	fun note(gatewayId: String, id: String, reason: String?) {
		val key = gatewayId to id
		refusals.value = if (reason == null) refusals.value - key else refusals.value + (key to reason)
	}

	suspend fun <T : Any> run(gatewayId: String, id: String, reasonOf: (T) -> String?, call: suspend () -> T): T {
		lateinit var answer: T
		val read = fence.read("$gatewayId/$id") { call().also { answer = it } }
		if (read is GatewayRead.Fresh) note(gatewayId, id, reasonOf(answer))
		return answer
	}

	fun clear() {
		fence.clear()
		refusals.value = emptyMap()
	}
}
