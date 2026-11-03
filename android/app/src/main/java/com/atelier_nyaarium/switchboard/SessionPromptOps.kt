package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleSessionPromptResult
import com.atelier_nyaarium.switchboard.proto.SessionPrompt
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * Prompt text by prompt id, and the owner's answers.
 *
 * Text never changes under its id, so no read is fenced.
 */
internal class SessionPromptOps(
	private val send: suspend (gatewayId: String, op: ConsoleOp) -> ConsoleClient.ValueAnswer,
) {
	private val _prompts = MutableStateFlow<Map<String, SessionPrompt>>(emptyMap())
	val prompts: StateFlow<Map<String, SessionPrompt>> = _prompts.asStateFlow()

	private val _answers = MutableStateFlow<Map<String, PromptAnswerState>>(emptyMap())
	val answers: StateFlow<Map<String, PromptAnswerState>> = _answers.asStateFlow()

	/** Fetches until `promptId`'s text is held. The caller cancels when presence moves on. */
	suspend fun keepLoaded(gatewayId: String, target: String, promptId: String) {
		while (promptId !in _prompts.value) {
			load(gatewayId, target)
			if (promptId !in _prompts.value) delay(RETRY_MS)
		}
	}

	private suspend fun load(gatewayId: String, target: String) {
		val answer = send(gatewayId, ConsoleOp.SessionPrompt(target)) as? ConsoleClient.ValueAnswer.Answered ?: return
		val prompt = runIsolated { wireJson.decodeFromJsonElement<ConsoleSessionPromptResult>(answer.result) }
			.getOrNull()
			?.prompt ?: return
		_prompts.update { recent(it + (prompt.id to prompt)) }
	}

	/** One answer in flight per prompt; a settled one is never sent again. */
	suspend fun answer(gatewayId: String, target: String, promptId: String, decision: String, reason: String?) {
		if (decision == PromptDecision.DENY && reason.isNullOrBlank()) return
		var claimed = false
		_answers.update { held ->
			val now = held[promptId]
			claimed = now != PromptAnswerState.Sending && now != PromptAnswerState.Settled
			if (claimed) recent(held + (promptId to PromptAnswerState.Sending)) else held
		}
		if (!claimed) return
		val op = ConsoleOp.SessionPromptAnswer(
			target = target,
			promptId = promptId,
			decision = decision,
			reason = reason?.trim()?.takeIf { it.isNotEmpty() },
		)
		val settled = answerStateOf(send(gatewayId, op))
		_answers.update { recent(it + (promptId to settled)) }
	}

	/** Drops what no session still waits on; an answer in flight stays. */
	fun retain(waiting: Collection<String>) {
		val keep = waiting.toSet()
		_answers.update { held -> held.filter { (id, state) -> id in keep || state == PromptAnswerState.Sending } }
		_prompts.update { held -> held.filterKeys { it in keep } }
	}

	private fun <V> recent(held: Map<String, V>): Map<String, V> =
		if (held.size <= KEPT) held else held.entries.drop(held.size - KEPT).associate { it.toPair() }

	private companion object {
		const val KEPT = 32
		const val RETRY_MS = 3_000L
	}
}
