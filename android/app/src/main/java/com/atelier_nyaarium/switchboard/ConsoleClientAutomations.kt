package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.decodeFromJsonElement

/** `serves` rides the same answer as the rows. */
internal suspend fun ConsoleClient.automationList(gatewayId: String): AutomationListing {
	val answer = sendValueAnswer(gatewayId, ConsoleOp.AutomationList)
	val listed = (answer as? ConsoleClient.ValueAnswer.Answered)?.let { held ->
		runIsolated { wireJson.decodeFromJsonElement<ConsoleAutomationListResult>(held.result) }.getOrNull()
	}
	val rows = listAnswerOf(answer, ProseRefusal.OLDER_BUILD) { listed?.automations }
	val prose = answer is ConsoleClient.ValueAnswer.Refused && answer.reason != Protocol.Wire.OP_REASON_NOT_SERVED
	return AutomationListing(rows, listed?.serves, prose, functions = listed?.functions)
}

internal suspend fun ConsoleClient.automationPut(
	gatewayId: String,
	automationId: String,
	automation: Automation,
	baseRevision: Long,
	confirmed: Boolean,
): ConsoleAutomationPutResult =
	valueResult(
		sendValueOp(
			gatewayId,
			ConsoleOp.AutomationPut(
				automationId = automationId,
				automation = automation,
				baseRevision = baseRevision,
				confirmed = true.takeIf { confirmed },
			),
		),
		Protocol.Wire.ConsoleOpKind.AUTOMATION_PUT,
	)

/** The automation with its function, as one write. */
internal suspend fun ConsoleClient.automationSave(gatewayId: String, op: ConsoleOp.AutomationSave): ConsoleAutomationSaveResult =
	valueResult(sendValueOp(gatewayId, op), Protocol.Wire.ConsoleOpKind.AUTOMATION_SAVE)

internal suspend fun ConsoleClient.automationDelete(
	gatewayId: String,
	automationId: String,
	baseRevision: Long,
): ConsoleAutomationDeleteResult =
	valueResult(
		sendValueOp(
			gatewayId,
			ConsoleOp.AutomationDelete(automationId = automationId, baseRevision = baseRevision),
		),
		Protocol.Wire.ConsoleOpKind.AUTOMATION_DELETE,
	)

internal suspend fun ConsoleClient.automationPreview(
	gatewayId: String,
	trigger: AutomationTrigger,
	text: String?,
): ConsoleAutomationPreviewResult? =
	when (val answer = sendValueAnswer(gatewayId, ConsoleOp.AutomationPreview(trigger = trigger, text = text))) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated { wireJson.decodeFromJsonElement<ConsoleAutomationPreviewResult>(answer.result) }.getOrNull()
		is ConsoleClient.ValueAnswer.Refused, is ConsoleClient.ValueAnswer.Undelivered, ConsoleClient.ValueAnswer.Unreachable -> null
	}
