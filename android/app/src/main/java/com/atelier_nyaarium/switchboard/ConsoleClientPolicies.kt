package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyListResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.decodeFromJsonElement

// A policy lives on one gateway, so every call names the one it means.

/** A refused list is the gateway's word; an unreachable one is no word at all. */
internal sealed interface PolicyListAnswer {
	data class Listed(val policies: List<AuthorizationPolicy>) : PolicyListAnswer
	data object Refused : PolicyListAnswer
	data object Unreachable : PolicyListAnswer
}

internal suspend fun ConsoleClient.policyList(gatewayId: String): PolicyListAnswer =
	when (val answer = sendValueAnswer(gatewayId, ConsoleOp.PolicyList)) {
		is ConsoleClient.ValueAnswer.Answered ->
			runCatching { wireJson.decodeFromJsonElement<ConsolePolicyListResult>(answer.result) }
				.map { PolicyListAnswer.Listed(it.policies) }
				.getOrElse { PolicyListAnswer.Unreachable }
		is ConsoleClient.ValueAnswer.Refused -> PolicyListAnswer.Refused
		is ConsoleClient.ValueAnswer.Undelivered -> PolicyListAnswer.Unreachable
		ConsoleClient.ValueAnswer.Unreachable -> PolicyListAnswer.Unreachable
	}

suspend fun ConsoleClient.policyPut(
	gatewayId: String,
	policy: AuthorizationPolicy,
	baseRevision: Long? = null,
): ConsolePolicyPutResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.PolicyPut(policy = policy, baseRevision = baseRevision)),
		Protocol.Wire.ConsoleOpKind.POLICY_PUT,
	)

suspend fun ConsoleClient.policyDelete(gatewayId: String, policyId: String, baseRevision: Long): ConsolePolicyDeleteResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.PolicyDelete(policyId = policyId, baseRevision = baseRevision)),
		Protocol.Wire.ConsoleOpKind.POLICY_DELETE,
	)

suspend fun ConsoleClient.policyEnable(
	gatewayId: String,
	policyId: String,
	enabled: Boolean,
	baseRevision: Long,
): ConsolePolicyPutResult =
	valueResult(
		sendValueOp(
			gatewayId,
			ConsoleOp.PolicyEnable(policyId = policyId, enabled = enabled, baseRevision = baseRevision),
		),
		Protocol.Wire.ConsoleOpKind.POLICY_ENABLE,
	)
