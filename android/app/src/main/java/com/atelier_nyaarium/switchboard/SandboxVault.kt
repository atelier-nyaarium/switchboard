package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.delay
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val VAULT_ROUND_TRIP_MS = 400L

/** Requests the sandbox refuses, with the code. */
internal val SANDBOX_VAULT_REFUSALS = mapOf("sandbox-sudo-refused" to "bound_elsewhere")

/** The emulator's Gateway for a vault answer; every other op is unreachable. */
internal suspend fun sandboxVaultAnswer(gatewayId: String, op: ConsoleOp): ConsoleClient.ValueAnswer {
	DebugLog.log("Sandbox", "vault answer on $gatewayId")
	delay(VAULT_ROUND_TRIP_MS)
	return when (op) {
		is ConsoleOp.VaultAnswer -> ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) })
		is ConsoleOp.VaultAnswerEntry -> ConsoleClient.ValueAnswer.Answered(
			SANDBOX_VAULT_REFUSALS[op.requestId]?.let { code ->
				buildJsonObject {
					put("ok", false)
					put("refusal", buildJsonObject { put("code", code) })
				}
			} ?: buildJsonObject { put("ok", true) },
		)
		else -> ConsoleClient.ValueAnswer.Unreachable
	}
}
