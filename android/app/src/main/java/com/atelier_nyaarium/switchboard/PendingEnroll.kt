package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

////////////////////////////////
//  Constants

/** Waits between status reads of one record; the last repeats. */
internal val ENROLL_CHECK_DELAYS_MS = listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L)

internal const val GATEWAY_PENDING_LINE = "Waiting for setup.sh, Gateway Setup"

internal const val GATEWAY_OUTDATED_LINE =
	"That machine runs an older Switchboard. Update it, then run setup.sh, Gateway Setup again."

////////////////////////////////
//  Interfaces & Types

/** An admitted Gateway whose setup has not collected its bundle. The Router holds a frame in
 * memory only, so it is kept here to hand in again. */
@Serializable
internal data class PendingEnroll(
	val gatewayId: String,
	/** The sealed bootstrap frame, as wire JSON. Sealed to that Gateway's box key. */
	val bundle: String,
	/** What the Router names the held frame by. */
	val pickupId: String,
	val gatewaySignPub: String,
	/** The roster's incarnation of this Gateway when it was admitted; zero when it had none. */
	val heldIncarnation: Long = 0L,
	val at: Long = 0L,
)

/** What a Gateways card says about one member. */
internal sealed interface GatewayCardState {
	data class Online(val sessions: Int) : GatewayCardState

	data class Offline(val sessions: Int) : GatewayCardState

	/** Admitted; its setup has not collected the bundle. */
	data object Pending : GatewayCardState
}

/** What a tick does for one pending record. */
internal enum class PendingStep {
	/** The Gateway registered, or is no longer a member. */
	RETIRE,
	WAIT,

	/** Ask whether the Router still holds the frame; hand it in when it does not. */
	CHECK,
}

/** What a scanned or pasted text is. */
internal sealed interface GatewayScan {
	data class Code(val gateway: ScannedGateway) : GatewayScan

	/** A code only an older Gateway shows. */
	data object Outdated : GatewayScan

	data object NotACode : GatewayScan
}

////////////////////////////////
//  Functions & Helpers

/** The Kotlin twin of `bootstrapPickupId`, pinned by tests/fixtures/gateway-bootstrap/vectors.json. */
internal fun bootstrapPickupId(code: String): String =
	MessageDigest.getInstance("SHA-256")
		.digest("${Protocol.Wire.SIGNING_TAG_GATEWAY_BOOTSTRAP_PICKUP}\n$code".toByteArray(Charsets.UTF_8))
		.joinToString("") { "%02x".format(it) }

/**
 * Whether the Gateway registered after this record was written. A registration mints a new
 * incarnation, so a roster still showing the one held at admission says nothing new.
 */
internal fun registeredSince(pending: PendingEnroll, entry: GatewayEntry?): Boolean =
	entry != null && entry.connected && entry.incarnation != pending.heldIncarnation

/** A pending record outranks the roster until a registration answers it. */
internal fun gatewayCardState(
	sessions: Int,
	registry: GatewayRegistry,
	gatewayId: String,
	pending: PendingEnroll?,
): GatewayCardState =
	when {
		pending != null && !registeredSince(pending, registry.entry(gatewayId)) -> GatewayCardState.Pending
		registry.standing(gatewayId) == GatewayStanding.Online -> GatewayCardState.Online(sessions)
		else -> GatewayCardState.Offline(sessions)
	}

internal fun gatewayCardLine(state: GatewayCardState): String {
	fun counted(word: String, sessions: Int) = "$word · $sessions session${if (sessions == 1) "" else "s"}"
	return when (state) {
		is GatewayCardState.Online -> counted("online", state.sessions)
		is GatewayCardState.Offline -> counted("offline", state.sessions)
		GatewayCardState.Pending -> GATEWAY_PENDING_LINE
	}
}

/** `member` is whether the owner's keyring still admits that Gateway. */
internal fun pendingStep(pending: PendingEnroll, entry: GatewayEntry?, member: Boolean, now: Long, dueAt: Long): PendingStep =
	when {
		!member || registeredSince(pending, entry) -> PendingStep.RETIRE
		now < dueAt -> PendingStep.WAIT
		else -> PendingStep.CHECK
	}

internal fun enrollCheckDelay(checks: Int): Long =
	ENROLL_CHECK_DELAYS_MS[checks.coerceIn(0, ENROLL_CHECK_DELAYS_MS.lastIndex)]

/** Reads a Gateway's enrollment code, as a QR or as the same JSON pasted. */
internal fun gatewayScanOf(text: String): GatewayScan = runIsolated {
	val scanned = Json.parseToJsonElement(text.trim()).jsonObject
	fun field(name: String): String = scanned.getValue(name).jsonPrimitive.content.also { require(it.isNotEmpty()) }
	when ((scanned["type"] as? JsonPrimitive)?.content) {
		"enroll-gateway" -> {
			val signPub = field("signPub")
			GatewayScan.Code(
				ScannedGateway(
					gatewayId = field("gatewayId"),
					signPub = signPub,
					boxPub = field("boxPub"),
					sas = Crypto.fingerprint(signPub),
					code = field("code"),
				),
			)
		}
		"admit-gateway" -> GatewayScan.Outdated
		else -> GatewayScan.NotACode
	}
}.getOrDefault(GatewayScan.NotACode)

// Lenient: an unknown field must not make the file unreadable.
private val pendingJson = Json {
	ignoreUnknownKeys = true
	encodeDefaults = true
}

private val pendingSerializer = MapSerializer(String.serializer(), PendingEnroll.serializer())

internal fun encodePendingEnrolls(map: Map<String, PendingEnroll>): String =
	pendingJson.encodeToString(pendingSerializer, map)

/** A corrupt blob reads as empty. */
internal fun decodePendingEnrolls(text: String?): Map<String, PendingEnroll> {
	if (text.isNullOrBlank()) return emptyMap()
	return runIsolated { pendingJson.decodeFromString(pendingSerializer, text) }.getOrDefault(emptyMap())
}
