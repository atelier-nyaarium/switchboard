package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantSendRequest
import com.atelier_nyaarium.switchboard.vault.Expiry
import com.atelier_nyaarium.switchboard.vault.expiresIn

internal data class AssistantSendCardText(
	val title: String,
	val fields: List<String>,
	val expiry: Expiry,
	val filesTitle: String,
	val files: List<String>,
	val noFiles: String,
	val bodyTitle: String,
	val body: String,
)

internal object AssistantSendWords {
	const val TITLE = "The assistant asks to send"
	const val APPROVE = "Approve"
	const val DENY = "Deny"
	const val BACK = "Back"
	const val NOTE = "Note"
	const val FILES = "Files"
	const val NO_FILES = "None"
	const val BODY = "Body"
	const val UNREACHABLE = "The Gateway could not be reached"
}

/** Omitted disposition means asking. */
internal fun assistantSendCardText(request: AssistantSendRequest, now: Long): AssistantSendCardText {
	val intent = request.intent
	val fields = buildList {
		add("To: ${intent.target}")
		intent.friendDomain?.let { add("Friend Domain: $it") }
		add("Disposition: ${intent.disposition ?: "asking"}")
		add("Label: ${intent.displayLabel ?: "none"}")
		add("Creates the session if absent: ${if (intent.createsSession) "yes" else "no"}")
	}
	return AssistantSendCardText(
		title = AssistantSendWords.TITLE,
		fields = fields,
		expiry = expiresIn(request.deadlineAt, now),
		filesTitle = AssistantSendWords.FILES,
		files = intent.files.map { "${it.filename} (${it.mime}), ${it.size} bytes, ${it.digest}" },
		noFiles = AssistantSendWords.NO_FILES,
		bodyTitle = AssistantSendWords.BODY,
		body = intent.body,
	)
}

/** Waiting card's settings label. */
internal fun assistantSendRowText(request: AssistantSendRequest): String = "Waiting: send to ${request.intent.target}"

/** Oldest deadline first. */
internal fun sendsWaitingOn(pending: List<PendingAssistantSend>, gatewayId: String): List<PendingAssistantSend> =
	pending.filter { it.gatewayId == gatewayId }.sortedBy { it.request.deadlineAt }

/** Hide request details publicly. */
internal fun assistantSendPublicNotificationText(): String = AssistantSendWords.TITLE
