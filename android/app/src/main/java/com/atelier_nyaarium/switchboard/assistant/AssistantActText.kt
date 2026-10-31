package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantActRequest
import com.atelier_nyaarium.switchboard.vault.Expiry
import com.atelier_nyaarium.switchboard.vault.VaultTile
import com.atelier_nyaarium.switchboard.vault.expiresIn

internal data class AssistantActCardText(
	val title: String,
	val key: String,
	val summary: String,
	val expiry: Expiry,
)

internal object AssistantActWords {
	const val TITLE = "The assistant asks to act"
	const val APPROVE = "Approve"
	const val DENY = "Deny"
	const val BACK = "Back"
	const val NOTE = "Note"
	const val UNREACHABLE = "The Gateway could not be reached"
}

internal fun assistantActCardText(request: AssistantActRequest, now: Long): AssistantActCardText = AssistantActCardText(
	title = AssistantActWords.TITLE,
	key = request.label,
	summary = request.summary,
	expiry = expiresIn(request.deadlineAt, now),
)

internal fun assistantActTile(pending: List<PendingAssistantAct>, gatewayId: String): VaultTile? {
	val here = pending.filter { it.gatewayId == gatewayId }
	val oldest = here.minByOrNull { it.request.deadlineAt } ?: return null
	val more = here.size - 1
	return VaultTile(
		requestId = oldest.request.requestId,
		title = if (more > 0) "${AssistantActWords.TITLE} (+$more)" else AssistantActWords.TITLE,
		requester = oldest.request.label,
		operation = oldest.request.summary,
		deadlineAt = oldest.request.deadlineAt,
	)
}
