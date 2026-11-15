package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.decodeFromJsonElement

internal suspend fun ConsoleClient.automationList(gatewayId: String): ListAnswer<AutomationRow> =
	listAnswer<ConsoleAutomationListResult, _>(gatewayId, ConsoleOp.AutomationList, ProseRefusal.OLDER_BUILD) { it.automations }

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
