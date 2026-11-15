package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.decodeFromJsonElement

internal sealed interface AutomationListAnswer {
	data class Listed(val automations: List<com.atelier_nyaarium.switchboard.proto.AutomationRow>) : AutomationListAnswer
	data object Refused : AutomationListAnswer
	data object Unreachable : AutomationListAnswer
}

internal suspend fun ConsoleClient.automationList(gatewayId: String): AutomationListAnswer =
	when (val answer = sendValueAnswer(gatewayId, ConsoleOp.AutomationList)) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated { wireJson.decodeFromJsonElement<ConsoleAutomationListResult>(answer.result) }
				.map { AutomationListAnswer.Listed(it.automations) }
				.getOrElse { AutomationListAnswer.Unreachable }
		is ConsoleClient.ValueAnswer.Refused -> AutomationListAnswer.Refused
		is ConsoleClient.ValueAnswer.Undelivered -> AutomationListAnswer.Unreachable
		ConsoleClient.ValueAnswer.Unreachable -> AutomationListAnswer.Unreachable
	}

internal suspend fun ConsoleClient.automationPut(
	gatewayId: String,
	automationId: String,
	automation: Automation,
	baseRevision: Long,
): ConsoleAutomationPutResult =
	valueResult(
		sendValueOp(
			gatewayId,
			ConsoleOp.AutomationPut(automationId = automationId, automation = automation, baseRevision = baseRevision),
		),
		Protocol.Wire.ConsoleOpKind.AUTOMATION_PUT,
	)

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
): ConsoleAutomationPreviewResult? =
	when (val answer = sendValueAnswer(gatewayId, ConsoleOp.AutomationPreview(trigger = trigger))) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated { wireJson.decodeFromJsonElement<ConsoleAutomationPreviewResult>(answer.result) }.getOrNull()
		is ConsoleClient.ValueAnswer.Refused, is ConsoleClient.ValueAnswer.Undelivered, ConsoleClient.ValueAnswer.Unreachable -> null
	}
