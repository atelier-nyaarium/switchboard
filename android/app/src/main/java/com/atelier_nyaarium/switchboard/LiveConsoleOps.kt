package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleVariable
import com.atelier_nyaarium.switchboard.liveconsole.variablesFor
import com.atelier_nyaarium.switchboard.liveconsole.withVariable
import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEvalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject

/** Gateway refusal differs from silence. */
internal sealed interface ConsoleCall<out T> {
	data class Answered<T>(val value: T) : ConsoleCall<T>

	data class Refused(val reason: String) : ConsoleCall<Nothing>

	data object Unreachable : ConsoleCall<Nothing>
}

internal interface LiveConsoleGateway {
	suspend fun describe(gatewayId: String): ConsoleCall<ConsoleDescribeResult>

	suspend fun ids(gatewayId: String): ConsoleCall<ConsoleIds>

	suspend fun eval(gatewayId: String, expr: String, variables: JsonObject?): ConsoleCall<ConsoleEvalResult>
}

internal interface LiveConsoleHost {
	val gateway: LiveConsoleGateway?
}

internal sealed interface ConsoleEntryState {
	data object Running : ConsoleEntryState

	data class Answered(val result: ConsoleEvalResult) : ConsoleEntryState

	data class Refused(val reason: String) : ConsoleEntryState

	data object Unreachable : ConsoleEntryState
}

internal data class ConsoleEntry(val id: Long, val expr: String, val state: ConsoleEntryState)

internal sealed interface ConsoleVocabulary {
	data object Loading : ConsoleVocabulary

	data object Ready : ConsoleVocabulary

	data class Refused(val reason: String) : ConsoleVocabulary

	data object Unreachable : ConsoleVocabulary
}

internal data class LiveConsoleView(
	val description: ConsoleDescription? = null,
	val registryHash: String? = null,
	val vocabulary: ConsoleVocabulary = ConsoleVocabulary.Loading,
	val ids: ConsoleIds? = null,
	val entries: List<ConsoleEntry> = emptyList(),
	val draft: String = "",
	val variables: Map<String, ConsoleVariable> = emptyMap(),
	val savedBy: Map<String, Long> = emptyMap(),
)

internal const val CONSOLE_HISTORY_MAX = 100

/** Answers survive screen removal. */
internal class LiveConsoleOps(private val host: LiveConsoleHost) : ClearsOnReprovision {
	private val views = MutableStateFlow<Map<String, LiveConsoleView>>(emptyMap())
	val state: StateFlow<Map<String, LiveConsoleView>> = views.asStateFlow()

	private val reads = GatewayReadFence()
	private val entryIds = AtomicLong(0)
	private val owner = AtomicLong(0)

	private fun change(gatewayId: String, transform: (LiveConsoleView) -> LiveConsoleView) {
		views.update { held -> held + (gatewayId to transform(held[gatewayId] ?: LiveConsoleView())) }
	}

	/** An answer begun under another owner lands nothing. */
	private fun land(began: Long, gatewayId: String, transform: (LiveConsoleView) -> LiveConsoleView) {
		views.update { held ->
			if (owner.get() != began) held else held + (gatewayId to transform(held[gatewayId] ?: LiveConsoleView()))
		}
	}

	override suspend fun clearInMemory() {
		// Bump before the wipe.
		owner.incrementAndGet()
		views.value = emptyMap()
	}

	fun viewOf(gatewayId: String): LiveConsoleView = views.value[gatewayId] ?: LiveConsoleView()

	fun setDraft(gatewayId: String, draft: String) = change(gatewayId) { it.copy(draft = draft) }

	fun recall(gatewayId: String): List<String> = viewOf(gatewayId).entries.asReversed().map { it.expr }.distinct()

	fun clear(gatewayId: String) = change(gatewayId) { it.copy(entries = emptyList()) }

	fun dropVariable(gatewayId: String, name: String) =
		// A read already sent cannot bring it back.
		change(gatewayId) { it.copy(variables = it.variables - name, savedBy = it.savedBy + (name to entryIds.get())) }

	suspend fun open(gatewayId: String) {
		describe(gatewayId)
		refreshIds(gatewayId)
	}

	suspend fun refreshIds(gatewayId: String) {
		val client = host.gateway ?: return
		val began = owner.get()
		val read = reads.read("$gatewayId/ids") { attempt { client.ids(gatewayId) } }
		val ids = ((read as? GatewayRead.Fresh)?.value as? ConsoleCall.Answered)?.value ?: return
		land(began, gatewayId) { it.copy(ids = ids) }
	}

	private suspend fun describe(gatewayId: String) {
		val client = host.gateway
		val began = owner.get()
		val read = reads.read("$gatewayId/describe") { client?.let { attempt { it.describe(gatewayId) } } }
		if (read !is GatewayRead.Fresh) return
		land(began, gatewayId) { view ->
			when (val answer = read.value) {
				is ConsoleCall.Answered ->
					view.copy(
						description = answer.value.description,
						registryHash = answer.value.registryHash,
						vocabulary = ConsoleVocabulary.Ready,
					)
				// Retain vocabulary after failure.
				is ConsoleCall.Refused ->
					if (view.description == null) view.copy(vocabulary = ConsoleVocabulary.Refused(answer.reason)) else view
				ConsoleCall.Unreachable, null ->
					if (view.description == null) view.copy(vocabulary = ConsoleVocabulary.Unreachable) else view
			}
		}
	}

	/** Late results settle by ID; changed hashes reload. */
	suspend fun run(gatewayId: String, expr: String) {
		val text = expr.trim()
		if (text.isEmpty()) return
		val id = entryIds.incrementAndGet()
		val began = owner.get()
		change(gatewayId) {
			it.copy(entries = (it.entries + ConsoleEntry(id, text, ConsoleEntryState.Running)).takeLast(CONSOLE_HISTORY_MAX), draft = "")
		}
		val sent = variablesFor(text, viewOf(gatewayId).variables)
		val answer = host.gateway?.let { client -> attempt { client.eval(gatewayId, text, sent) } } ?: ConsoleCall.Unreachable
		val landed =
			when (answer) {
				is ConsoleCall.Answered -> ConsoleEntryState.Answered(answer.value)
				is ConsoleCall.Refused -> ConsoleEntryState.Refused(answer.reason)
				ConsoleCall.Unreachable -> ConsoleEntryState.Unreachable
			}
		val result = (answer as? ConsoleCall.Answered)?.value
		val saved = (result as? ConsoleEvalResult.Ok)?.results.orEmpty().mapNotNull { item ->
			item.assigned?.let { it to ConsoleVariable(item.value, item.type) }
		}
		land(began, gatewayId) { view ->
			// Newer saves win.
			val fresh = saved.filter { (name, _) -> (view.savedBy[name] ?: 0) < id }
			view.copy(
				entries = view.entries.map { if (it.id == id) it.copy(state = landed) else it },
				variables = fresh.fold(view.variables) { held, (name, variable) -> withVariable(held, name, variable) },
				savedBy = view.savedBy + fresh.map { (name, _) -> name to id },
			)
		}
		val hash =
			when (result) {
				is ConsoleEvalResult.Ok -> result.registryHash
				is ConsoleEvalResult.Error -> result.registryHash
				null -> null
			}
		if (owner.get() != began) return
		if (hash != null && hash != viewOf(gatewayId).registryHash) describe(gatewayId)
		if (result != null) refreshIds(gatewayId)
	}

	private suspend fun <T> attempt(call: suspend () -> ConsoleCall<T>): ConsoleCall<T> =
		runCatchingCancellable { call() }.getOrElse {
			DebugLog.log("LiveConsole", "gateway call failed: ${it.message}")
			ConsoleCall.Unreachable
		}
}
