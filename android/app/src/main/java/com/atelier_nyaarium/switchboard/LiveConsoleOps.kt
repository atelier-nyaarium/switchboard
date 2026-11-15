package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.CONSOLE_RECALL_SHOWN
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleVariable
import com.atelier_nyaarium.switchboard.liveconsole.variablesFor
import com.atelier_nyaarium.switchboard.liveconsole.withVariable
import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEvalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import kotlinx.coroutines.flow.StateFlow
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
	val generation: ProvisionFence

	fun names(gatewayId: String): Boolean
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
	/** Newest issued entry ID. */
	val minted: Long = 0,
)

internal data class ConsoleVocabularyPart(
	val description: ConsoleDescription?,
	val registryHash: String?,
	val vocabulary: ConsoleVocabulary,
	val variables: Map<String, ConsoleVariable>,
)

internal data class ConsoleRunPart(
	val entries: List<ConsoleEntry>,
	val draft: String,
	val minted: Long,
	val variables: Map<String, ConsoleVariable>,
	val savedBy: Map<String, Long>,
	val entities: Set<String>,
)

internal sealed interface ConsoleSlot<S> : Slot<LiveConsoleView, S> {
	data object Vocabulary : ConsoleSlot<ConsoleVocabularyPart> {
		override fun read(view: LiveConsoleView) =
			ConsoleVocabularyPart(view.description, view.registryHash, view.vocabulary, view.variables)

		override fun write(view: LiveConsoleView, part: ConsoleVocabularyPart) =
			view.copy(
				description = part.description,
				registryHash = part.registryHash,
				vocabulary = part.vocabulary,
				variables = part.variables,
			)
	}

	data object Ids : ConsoleSlot<ConsoleIds?> {
		override fun read(view: LiveConsoleView) = view.ids

		override fun write(view: LiveConsoleView, part: ConsoleIds?) = view.copy(ids = part)
	}

	/** Per-run row and answer. */
	class Run : ConsoleSlot<ConsoleRunPart> {
		override fun read(view: LiveConsoleView) =
			ConsoleRunPart(
				view.entries,
				view.draft,
				view.minted,
				view.variables,
				view.savedBy,
				view.description?.entities.orEmpty().map { it.name }.toSet(),
			)

		override fun write(view: LiveConsoleView, part: ConsoleRunPart) =
			view.copy(
				entries = part.entries,
				draft = part.draft,
				minted = part.minted,
				variables = part.variables,
				savedBy = part.savedBy,
			)
	}

	data object Draft : ConsoleSlot<String> {
		override fun read(view: LiveConsoleView) = view.draft

		override fun write(view: LiveConsoleView, part: String) = view.copy(draft = part)
	}
}

/** An entity outranks a saved name. */
internal fun vocabularyAfter(
	held: ConsoleVocabularyPart,
	answer: ConsoleCall<ConsoleDescribeResult>,
): ConsoleVocabularyPart =
	when (answer) {
		is ConsoleCall.Answered -> {
			val entities = answer.value.description.entities.map { it.name }.toSet()
			ConsoleVocabularyPart(
				answer.value.description,
				answer.value.registryHash,
				ConsoleVocabulary.Ready,
				held.variables.filterKeys { it !in entities },
			)
		}
		// Preserve loaded vocabulary on failure.
		is ConsoleCall.Refused ->
			if (held.description == null) held.copy(vocabulary = ConsoleVocabulary.Refused(answer.reason)) else held
		ConsoleCall.Unreachable ->
			if (held.description == null) held.copy(vocabulary = ConsoleVocabulary.Unreachable) else held
	}

/** Newer saves win. */
internal fun runSettled(held: ConsoleRunPart, id: Long, answer: ConsoleCall<ConsoleEvalResult>): ConsoleRunPart {
	val landed =
		when (answer) {
			is ConsoleCall.Answered -> ConsoleEntryState.Answered(answer.value)
			is ConsoleCall.Refused -> ConsoleEntryState.Refused(answer.reason)
			ConsoleCall.Unreachable -> ConsoleEntryState.Unreachable
		}
	val saved =
		((answer as? ConsoleCall.Answered)?.value as? ConsoleEvalResult.Ok)?.results.orEmpty().mapNotNull { item ->
			item.assigned?.let { it to ConsoleVariable(item.value, item.type) }
		}
	val fresh = saved.filter { (name, _) -> (held.savedBy[name] ?: 0) < id && name !in held.entities }
	return held.copy(
		entries = held.entries.map { if (it.id == id) it.copy(state = landed) else it },
		variables = fresh.fold(held.variables) { all, (name, variable) -> withVariable(all, name, variable) },
		savedBy = held.savedBy + fresh.map { (name, _) -> name to id },
	)
}

internal const val CONSOLE_HISTORY_MAX = 100

/** Answers survive screen removal. */
internal class LiveConsoleOps(private val host: LiveConsoleHost) : ClearsOnReprovision {
	private val slots = SlotViews<String, LiveConsoleView>(host.generation, ::LiveConsoleView)

	val state: StateFlow<Map<String, LiveConsoleView>> get() = slots.all

	fun viewOf(gatewayId: String): LiveConsoleView = slots.of(gatewayId) ?: LiveConsoleView()

	override suspend fun clearInMemory() = slots.clear()

	fun setDraft(gatewayId: String, draft: String) {
		slots.land(slots.begin(gatewayId, ConsoleSlot.Draft)) { draft }
	}

	/** Newest first, each once. */
	fun recall(gatewayId: String): List<String> =
		viewOf(gatewayId).entries.asReversed().map { it.expr }.distinct().take(CONSOLE_RECALL_SHOWN)

	/** A read already sent cannot bring it back. */
	fun dropVariable(gatewayId: String, name: String) {
		slots.land(slots.begin(gatewayId, ConsoleSlot.Run())) {
			it.copy(variables = it.variables - name, savedBy = it.savedBy + (name to it.minted))
		}
	}

	suspend fun open(gatewayId: String) {
		describe(gatewayId)
		refreshIds(gatewayId)
	}

	suspend fun refreshIds(gatewayId: String) {
		val ticket = slots.begin(gatewayId, ConsoleSlot.Ids)
		val ids = (ask(gatewayId) { it.ids(gatewayId) } as? ConsoleCall.Answered)?.value ?: return
		slots.land(ticket) { ids }
	}

	private suspend fun describe(gatewayId: String) {
		val ticket = slots.begin(gatewayId, ConsoleSlot.Vocabulary)
		val answer = ask(gatewayId) { it.describe(gatewayId) }
		slots.land(ticket) { vocabularyAfter(it, answer) }
	}

	/** Changed hashes refresh vocabulary. */
	suspend fun run(gatewayId: String, expr: String) {
		val text = expr.trim()
		if (text.isEmpty()) return
		val ticket = slots.begin(gatewayId, ConsoleSlot.Run())
		var id = 0L
		val appended =
			slots.land(ticket) { held ->
				id = held.minted + 1
				val row = ConsoleEntry(id, text, ConsoleEntryState.Running)
				held.copy(entries = (held.entries + row).takeLast(CONSOLE_HISTORY_MAX), draft = "", minted = id)
			}
		if (!appended) return
		val sent = variablesFor(text, viewOf(gatewayId).variables)
		val answer = ask(gatewayId) { it.eval(gatewayId, text, sent) }
		if (!slots.land(ticket) { runSettled(it, id, answer) }) return
		val hash =
			when (val result = (answer as? ConsoleCall.Answered)?.value) {
				is ConsoleEvalResult.Ok -> result.registryHash
				is ConsoleEvalResult.Error -> result.registryHash
				null -> return
			}
		if (hash != viewOf(gatewayId).registryHash) describe(gatewayId)
		refreshIds(gatewayId)
	}

	private suspend fun <T> ask(gatewayId: String, call: suspend (LiveConsoleGateway) -> ConsoleCall<T>): ConsoleCall<T> {
		if (!host.names(gatewayId)) return ConsoleCall.Unreachable
		val client = host.gateway ?: return ConsoleCall.Unreachable
		return runCatchingCancellable { call(client) }.getOrElse {
			DebugLog.log("LiveConsole", "gateway call failed: ${it::class.simpleName}")
			ConsoleCall.Unreachable
		}
	}
}
