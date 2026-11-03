package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleSessionPromptAnswerResult
import com.atelier_nyaarium.switchboard.proto.SessionPrompt
import kotlinx.serialization.json.decodeFromJsonElement

////////////////////////////////
//  Types

/** Where an answer to one prompt stands. */
internal sealed interface PromptAnswerState {
	data object Sending : PromptAnswerState

	/** Answered, or gone first. Hidden until presence lets go. */
	data object Settled : PromptAnswerState

	data class Failed(val reason: String) : PromptAnswerState
}

/** What the top of a conversation draws for its prompt. */
internal data class ApprovalView(
	val promptId: String,
	/** Null while its text loads. */
	val prompt: SessionPrompt?,
	val answer: PromptAnswerState?,
) {
	val sending: Boolean get() = answer == PromptAnswerState.Sending
	val failure: String? get() = (answer as? PromptAnswerState.Failed)?.reason

	/** Its text has loaded and no answer is in flight. */
	val answerable: Boolean get() = prompt != null && !sending
}

internal data class PromptNotices(val post: List<String>, val cancel: List<String>)

internal object PromptDecision {
	const val APPROVE = "approve"
	const val DENY = "deny"
}

////////////////////////////////
//  Functions

/** Every online session holding a prompt: team to prompt id. */
internal fun waitingPrompts(state: ChatState): Map<String, String> =
	state.teams
		.mapNotNull { team -> team.presence.takeIf { it.isOnline }?.promptId?.let { team.name to it } }
		.toMap()

internal fun waitingPromptOf(state: ChatState, team: String): String? = waitingPrompts(state)[team]

/** The approval a conversation draws, or null once answered. */
internal fun approvalView(
	promptId: String?,
	prompts: Map<String, SessionPrompt>,
	answers: Map<String, PromptAnswerState>,
): ApprovalView? {
	if (promptId == null) return null
	val answer = answers[promptId]
	if (answer == PromptAnswerState.Settled) return null
	return ApprovalView(promptId, prompts[promptId], answer)
}

/** A deny always carries a steer. */
internal fun denyReady(view: ApprovalView, reason: String): Boolean = view.answerable && reason.isNotBlank()

/** Posted once per prompt id while this phone alerts; cancelled when it stops waiting or alerting. */
internal fun promptNotices(posted: Map<String, String>, waiting: Map<String, String>, alerts: Boolean): PromptNotices =
	if (!alerts) {
		PromptNotices(post = emptyList(), cancel = posted.keys.toList())
	} else {
		PromptNotices(
			post = waiting.filter { (team, id) -> posted[team] != id }.keys.toList(),
			cancel = posted.keys.filter { it !in waiting },
		)
	}

/** What stands posted once `sent` of `notices` went out. */
internal fun postedAfter(
	posted: Map<String, String>,
	waiting: Map<String, String>,
	notices: PromptNotices,
	sent: Collection<String>,
): Map<String, String> = posted - notices.cancel.toSet() + waiting.filterKeys { it in sent }

/** Answered and stale both settle: either way this prompt is done. */
internal fun answerStateOf(answer: ConsoleClient.ValueAnswer): PromptAnswerState =
	when (answer) {
		is ConsoleClient.ValueAnswer.Answered ->
			if (runIsolated { wireJson.decodeFromJsonElement<ConsoleSessionPromptAnswerResult>(answer.result) }.isSuccess) {
				PromptAnswerState.Settled
			} else {
				PromptAnswerState.Failed("The Gateway's answer was unreadable")
			}
		is ConsoleClient.ValueAnswer.Refused -> PromptAnswerState.Failed(answer.reason)
		is ConsoleClient.ValueAnswer.Undelivered -> PromptAnswerState.Failed("Not delivered: ${answer.reason}")
		ConsoleClient.ValueAnswer.Unreachable -> PromptAnswerState.Failed("The Gateway could not be reached")
	}
