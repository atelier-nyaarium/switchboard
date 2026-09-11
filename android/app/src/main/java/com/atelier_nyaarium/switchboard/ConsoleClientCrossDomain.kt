package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.CrossDomainCancelResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainConfirmResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListPeersResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListSharesResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenStateResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareValue
import com.atelier_nyaarium.switchboard.proto.CrossDomainUnlinkResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainUnshareResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

suspend fun ConsoleClient.crossDomainListen(gatewayId: String): CrossDomainListenResult =
	valueResult(sendValueOp(gatewayId, ConsoleOp.CrossDomainListen), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LISTEN)

// Cross-domain requests carry stable opIds for retry safety.
suspend fun ConsoleClient.crossDomainRequest(
	gatewayId: String,
	listeningToken: String,
	pin: String,
	requesterOwnerSignPub: String,
	requesterDomainId: String,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainRequestResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.CrossDomainRequest(
				listeningToken = listeningToken,
				pin = pin,
				requesterOwnerSignPub = requesterOwnerSignPub,
				requesterDomainId = requesterDomainId,
		), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_REQUEST,
	)

suspend fun ConsoleClient.crossDomainConfirm(
	gatewayId: String,
	pin: String,
	mySignedLink: SignedXDomainLink,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainConfirmResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.CrossDomainConfirm(pin = pin, mySignedLink = mySignedLink), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_CONFIRM,
	)

suspend fun ConsoleClient.crossDomainListenState(gatewayId: String, listeningToken: String): CrossDomainListenStateResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.CrossDomainListenState(listeningToken = listeningToken)),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LISTEN_STATE,
	)

suspend fun ConsoleClient.crossDomainCancel(gatewayId: String, listeningToken: String? = null, pin: String? = null): CrossDomainCancelResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.CrossDomainCancel(listeningToken = listeningToken, pin = pin)),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_CANCEL,
	)

/** A refusal names its reason; an unlanded write its outcome. */
private fun ownerResult(answer: kotlinx.serialization.json.JsonElement?, kind: String): JsonObject {
	if (answer == null) error("$kind timed out")
	val body = answer.jsonObject
	val outcome = body["outcome"]?.jsonPrimitive?.contentOrNull
	if (outcome != null && outcome != Protocol.Wire.OP_OUTCOME_ACCEPTED) {
		error(body["reason"]?.jsonPrimitive?.contentOrNull ?: outcome)
	}
	if (body["ok"]?.jsonPrimitive?.booleanOrNull == false) error("$kind was not taken")
	return body
}

private fun shareFields(sessionTarget: String, target: CrossDomainShareTarget): JsonObject =
	wireJson.encodeToJsonElement(CrossDomainShareValue.serializer(), CrossDomainShareValue(sessionTarget, target)).jsonObject

suspend fun ConsoleClient.crossDomainShare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainShareResult {
	val value = shareFields(sessionTarget, target)
	return wireJson.decodeFromJsonElement(CrossDomainShareResult.serializer(), ownerResult(postSigned(buildJsonObject {
	put("kind", Protocol.Wire.OWNER_OP_CROSS_DOMAIN_SHARE)
	put("sessionTarget", value.getValue("sessionTarget"))
	put("target", value.getValue("target"))
}, opId), Protocol.Wire.OWNER_OP_CROSS_DOMAIN_SHARE))
}

suspend fun ConsoleClient.crossDomainUnshare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainUnshareResult {
	val value = shareFields(sessionTarget, target)
	return wireJson.decodeFromJsonElement(CrossDomainUnshareResult.serializer(), ownerResult(postSigned(buildJsonObject {
	put("kind", Protocol.Wire.OWNER_OP_CROSS_DOMAIN_UNSHARE)
	put("sessionTarget", value.getValue("sessionTarget"))
	put("target", value.getValue("target"))
}, opId), Protocol.Wire.OWNER_OP_CROSS_DOMAIN_UNSHARE))
}

suspend fun ConsoleClient.crossDomainListShares(): CrossDomainListSharesResult = wireJson.decodeFromJsonElement(
	CrossDomainListSharesResult.serializer(), ownerResult(postSigned(buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_CROSS_DOMAIN_LIST_SHARES)
	}), Protocol.Wire.OWNER_OP_CROSS_DOMAIN_LIST_SHARES),
)

suspend fun ConsoleClient.crossDomainListPeers(gatewayId: String): CrossDomainListPeersResult =
	valueResult(sendValueOp(gatewayId, ConsoleOp.CrossDomainListPeers), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LIST_PEERS)

suspend fun ConsoleClient.crossDomainUntrust(gatewayId: String, ownerSignPub: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
	valueResult(sendValueOp(gatewayId, ConsoleOp.CrossDomainUntrust(ownerSignPub = ownerSignPub), opId), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNTRUST)
