package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyListResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import com.atelier_nyaarium.switchboard.proto.Protocol

// A policy lives on one gateway, so every call names the one it means.

internal suspend fun ConsoleClient.policyList(gatewayId: String): ListAnswer<AuthorizationPolicy> =
	listAnswer<ConsolePolicyListResult, _>(gatewayId, ConsoleOp.PolicyList, ProseRefusal.FAULT) { it.policies }

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
