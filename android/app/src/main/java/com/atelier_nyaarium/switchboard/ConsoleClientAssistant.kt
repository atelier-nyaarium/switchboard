package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.serialization.json.decodeFromJsonElement

// The assistant lives on one gateway, so every call names the one it means.

/** A refusal carries the gateway's reason; unreachable is no word at all. */
internal sealed interface AssistantAnswer {
	data class State(val state: ConsoleAssistantStateResult) : AssistantAnswer
	data class Refused(val reason: String) : AssistantAnswer
	data object Unreachable : AssistantAnswer
}

/** Null if unanswered. */
internal suspend fun ConsoleClient.assistantPreview(gatewayId: String, op: ConsoleOp): ConsoleAssistantPreviewResult? =
	when (val answer = sendValueAnswer(gatewayId, op)) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated { wireJson.decodeFromJsonElement<ConsoleAssistantPreviewResult>(answer.result) }.getOrNull()
		else -> null
	}

internal suspend fun ConsoleClient.assistantOp(gatewayId: String, op: ConsoleOp): AssistantAnswer =
	when (val answer = sendValueAnswer(gatewayId, op)) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated<AssistantAnswer> {
				AssistantAnswer.State(wireJson.decodeFromJsonElement<ConsoleAssistantStateResult>(answer.result))
			}.getOrElse { AssistantAnswer.Unreachable }
		is ConsoleClient.ValueAnswer.Refused -> AssistantAnswer.Refused(answer.reason)
		is ConsoleClient.ValueAnswer.Undelivered -> AssistantAnswer.Unreachable
		ConsoleClient.ValueAnswer.Unreachable -> AssistantAnswer.Unreachable
	}
