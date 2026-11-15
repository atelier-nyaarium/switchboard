package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleEvalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

private const val UNREADABLE = "This app cannot read the Gateway's answer; update one of them"

private suspend inline fun <reified T> ConsoleClient.consoleCall(gatewayId: String, op: ConsoleOp): ConsoleCall<T> =
	when (val answer = sendValueAnswer(gatewayId, op)) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated { wireJson.decodeFromJsonElement<T>(answer.result) }
				.fold({ ConsoleCall.Answered(it) }, { ConsoleCall.Refused(UNREADABLE) })
		is ConsoleClient.ValueAnswer.Refused -> ConsoleCall.Refused(answer.reason)
		is ConsoleClient.ValueAnswer.Undelivered -> ConsoleCall.Unreachable
		ConsoleClient.ValueAnswer.Unreachable -> ConsoleCall.Unreachable
	}

internal suspend fun ConsoleClient.consoleDescribe(gatewayId: String): ConsoleCall<ConsoleDescribeResult> =
	consoleCall(gatewayId, ConsoleOp.ConsoleDescribe)

internal suspend fun ConsoleClient.consoleIds(gatewayId: String): ConsoleCall<ConsoleIds> =
	consoleCall(gatewayId, ConsoleOp.ConsoleIds)

internal suspend fun ConsoleClient.consoleEval(
	gatewayId: String,
	expr: String,
	variables: JsonObject? = null,
): ConsoleCall<ConsoleEvalResult> = consoleCall(gatewayId, ConsoleOp.ConsoleEval(expr = expr, variables = variables))
