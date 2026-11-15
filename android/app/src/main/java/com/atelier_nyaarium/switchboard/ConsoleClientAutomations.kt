package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.decodeFromJsonElement

/** `serves` rides the same answer as the rows. */
internal suspend fun ConsoleClient.automationList(gatewayId: String): AutomationListing {
	var serves: AutomationServes? = null
	val rows = listAnswer<ConsoleAutomationListResult, AutomationRow>(gatewayId, ConsoleOp.AutomationList, ProseRefusal.OLDER_BUILD) {
		serves = it.serves
		it.automations
	}
	return AutomationListing(rows, serves)
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
