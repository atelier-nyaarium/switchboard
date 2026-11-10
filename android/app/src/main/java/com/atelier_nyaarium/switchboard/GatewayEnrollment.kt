package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapPutResult
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapPutValue
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapStatusResult
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapStatusValue
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** [EnrollRouter] over signed owner ops. `post` answers null for no answer. */
internal class OwnerOpEnrollRouter(private val post: suspend (JsonObject) -> JsonElement?) : EnrollRouter {
	override suspend fun held(pickupId: String): Boolean? = ownerOpResult(
		post(wireJson.encodeToJsonElement(GatewayBootstrapStatusValue.serializer(), GatewayBootstrapStatusValue(pickupId = pickupId)).jsonObject),
		GatewayBootstrapStatusResult.serializer(),
	)?.held

	override suspend fun put(pickupId: String, gatewaySignPub: String, frame: GatewayBootstrapFrame): GatewayBootstrapPutResult? = ownerOpResult(
		post(
			wireJson.encodeToJsonElement(
				GatewayBootstrapPutValue.serializer(),
				GatewayBootstrapPutValue(pickupId = pickupId, gatewaySignPub = gatewaySignPub, frame = frame),
			).jsonObject,
		),
		GatewayBootstrapPutResult.serializer(),
	)
}

internal fun handInRefusalLine(refusal: String?): String = "Added, but the Router refused the bundle (${refusal ?: "no reason given"})."

internal class GatewayEnrollment(private val repo: ChatRepository) {
	val setups = PendingEnrollOps(
		load = repo.store::loadPendingEnrolls,
		save = repo.store::savePendingEnrolls,
		router = OwnerOpEnrollRouter { op ->
			// The sandbox reaches no Router, and an owner op there cancels its caller.
			if (isSandbox) null else runCatchingCancellable { repo.client().postSigned(op) }.getOrNull()
		},
		registry = { repo.state.value.gateways },
		member = { signPub -> repo.federation.members().any { it.kind == "gateway" && it.signPub == signPub } },
	)

	/** Admits the Gateway, seals its bundle, keeps it, and hands it to the Router. */
	suspend fun enrollGateway(scanned: ScannedGateway): EnrollDelivery = withContext(Dispatchers.IO) {
		val ready = repo.readyOrNull()
			?: return@withContext EnrollDelivery(false, "This phone has not confirmed its Domain yet.")
		val heldIncarnation = repo.state.value.gateways.entry(scanned.gatewayId)?.incarnation ?: 0L
		val signed = repo.ownerFacts.admitGateway(scanned.gatewayId, scanned.signPub, scanned.boxPub)
			?: return@withContext EnrollDelivery(false, repo._state.value.error ?: "Couldn't add the Gateway. Try again.")
		val result = try {
			repo.client().requestGatewayTransport(repo.federation.signTransportRequest(System.currentTimeMillis()))
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			return@withContext EnrollDelivery(
				false,
				"Added, but couldn't finish Gateway setup: ${e.message?.take(120) ?: "unknown error"}",
			)
		}
		val missing = result.routerUrl == null || result.routerCertFp == null || result.bearer == null
		if (!result.ok || missing) {
			return@withContext EnrollDelivery(
				false,
				"Added, but couldn't finish Gateway setup: ${result.error?.take(120) ?: "transport unavailable"}",
			)
		}
		val transport = GatewayTransport(
			routerUrl = result.routerUrl,
			routerCertFp = result.routerCertFp,
			bearer = result.bearer,
		)
		val frame = repo.federation.sealBundle(
			scanned.code,
			transport,
			signed,
			scanned.boxPub,
			ready.domainId,
			ready.contentKeyring,
			repo.state.value.owner?.displayName,
		)
		val record = PendingEnroll(
			gatewayId = scanned.gatewayId,
			bundle = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), frame),
			pickupId = bootstrapPickupId(scanned.code),
			gatewaySignPub = scanned.signPub,
			heldIncarnation = heldIncarnation,
			at = System.currentTimeMillis(),
		)
		// Kept first, so the drain retries a hand-in that got no answer.
		setups.note(record)
		val handed = setups.handIn(record)
		if (handed?.held == false) EnrollDelivery(false, handInRefusalLine(handed.refusal)) else EnrollDelivery(true, "")
	}
}
