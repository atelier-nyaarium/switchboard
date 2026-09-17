package com.atelier_nyaarium.switchboard

import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** An outline's ask for windows, held until a reply names symbols to open. */
internal data class WindowRequest(
	val target: WorkspaceTarget,
	val module: String,
	val text: String,
	val sentAt: Long,
	/** Which ask this is, not which text, so a replacement is never mistaken for what it replaced. */
	val incarnation: Long,
	/** Null while it waits. */
	val opened: List<String>? = null,
	val landed: Boolean = false,
)

/** For the drift between the phone's clock and the Gateway's. */
internal const val WINDOWS_ASK_SKEW_MS = 5_000L

internal const val WINDOWS_ASK_LEAD = "Open windows on my phone"

internal fun windowsAsk(module: String, text: String): String =
	"""
	$WINDOWS_ASK_LEAD in `$module`: $text

	Reply with one `ref://` link per declaration to open, each naming its chain, like `ref://$module:Container:member`.
	""".trimIndent()

/** The symbols a reply names, in order, or null when it does not answer the request. */
internal fun answeredWindows(request: WindowRequest, message: Message): List<String>? {
	if (message.fromMe || message.isPeer || message.status != null) return null
	if (request.opened != null || message.at < request.sentAt - WINDOWS_ASK_SKEW_MS) return null
	return message.files
		.flatMap { it.ref?.keys.orEmpty() }
		.mapNotNull { it.symbolId?.ifBlank { null } }
		.distinct()
		.ifEmpty { null }
}

internal fun landsOnWindows(request: WindowRequest?): Boolean = request?.opened != null && !request.landed

internal fun windowsAskNotice(submitted: Submitted): String? =
	when (submitted) {
		Submitted.Sent -> null
		Submitted.AlreadySending -> "Already asking"
		Submitted.Failed -> "That did not leave the phone"
	}

/**
 * One request per session. The first reply after it that names symbols opens them through `open`, the
 * one road a window opens by; a reply naming none leaves it waiting. Memory only.
 */
internal class WindowRequests(
	private val generation: WorkspaceGeneration,
	private val outbox: SessionRequests,
	/** True when the window opened. */
	private val open: suspend (WorkspaceTarget, String) -> Boolean,
	private val scope: CoroutineScope,
	private val now: () -> Long,
) : ClearsOnReprovision, InboundSubscriber {
	private val held = MutableStateFlow<Map<String, WindowRequest>>(emptyMap())

	private val incarnations = AtomicLong(0)

	val requests: StateFlow<Map<String, WindowRequest>> = held

	/** Held before the send, so a reply that beats the send's answer still finds it. */
	suspend fun ask(target: WorkspaceTarget, module: String, text: String): Submitted {
		val address = target.address
		val captured = generation.capture()
		val request = WindowRequest(target, module, text.trim(), now(), incarnations.incrementAndGet())
		val previous = held.value[address]
		held.update { it + (address to request) }
		return withContext(NonCancellable) {
			val key = RequestKey(address, RequestKind.WINDOWS, "")
			val submitted = outbox.submit(key, windowsAsk(module, request.text), captured)
			if (submitted != Submitted.Sent) {
				held.update { all ->
					when {
						all[address] !== request -> all
						submitted == Submitted.AlreadySending && previous != null -> all + (address to previous)
						else -> all - address
					}
				}
			}
			submitted
		}
	}

	fun dismiss(target: WorkspaceTarget) {
		held.update { it - target.address }
	}

	fun landed(request: WindowRequest) {
		held.update { all ->
			if (all[request.target.address] == request) all + (request.target.address to request.copy(landed = true)) else all
		}
	}

	override fun onMessage(team: String, msg: Message) {
		var answered: WindowRequest? = null
		held.update { all ->
			answered = null
			val request = all[team] ?: return@update all
			val symbols = answeredWindows(request, msg) ?: return@update all
			request.copy(opened = symbols).let { opened ->
				answered = opened
				all + (team to opened)
			}
		}
		val request = answered ?: return
		scope.launch {
			var any = false
			for (symbolId in request.opened.orEmpty()) {
				// A dismissed or replaced ask opens nothing more.
				if (!sameAsk(held.value[team], request)) return@launch
				any = openedOne(request.target, symbolId) || any
			}
			if (!any) {
				held.update { all ->
					all[team]?.takeIf { sameAsk(it, request) }?.let { all + (team to it.copy(opened = null, landed = false)) } ?: all
				}
			}
		}
	}

	private suspend fun openedOne(target: WorkspaceTarget, symbolId: String): Boolean =
		try {
			open(target, symbolId)
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("WindowRequests", "open failed: ${e.message}")
			false
		}

	private fun sameAsk(held: WindowRequest?, request: WindowRequest): Boolean =
		held != null && held.incarnation == request.incarnation

	override suspend fun clearInMemory() {
		held.value = emptyMap()
	}
}
