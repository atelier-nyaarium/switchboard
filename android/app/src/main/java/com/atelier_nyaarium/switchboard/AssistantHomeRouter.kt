package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentSealing
import com.atelier_nyaarium.switchboard.crypto.assistantHomeAadKind
import com.atelier_nyaarium.switchboard.proto.AssistantHomePutResult
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReadResult
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
import com.atelier_nyaarium.switchboard.proto.AssistantHomeSealed
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The Router's home record, as held. */
sealed interface AssistantHome {
	data object Unread : AssistantHome

	/** A null record was never written. */
	data class Read(val record: AssistantHomeRecord?, val report: AssistantHomeReport?) : AssistantHome
}

/** Testable without a transport. */
internal interface AssistantHomeRouter {
	/** Null when unanswered. */
	suspend fun read(): AssistantHomeReadResult?

	suspend fun put(baseVersion: Long, gatewayId: String?, sealed: ContentEnvelope?): HomePut

	/** Null without a content key. */
	fun seal(gatewayId: String, version: Long, sealed: AssistantHomeSealed): ContentEnvelope?

	/** Null without its key. */
	fun open(gatewayId: String, version: Long, envelope: ContentEnvelope): AssistantHomeSealed?
}

/** What a put answered. */
internal sealed interface HomePut {
	data class Applied(val record: AssistantHomeRecord?) : HomePut

	data class Conflict(val record: AssistantHomeRecord?) : HomePut

	data class Refused(val reason: String?) : HomePut

	/** No answer, or one that may have landed. */
	data class Uncertain(val reason: String?) : HomePut
}

internal fun homePutOf(result: AssistantHomePutResult): HomePut = when (result.outcome) {
	PUT_APPLIED -> HomePut.Applied(result.record)
	PUT_CONFLICT -> HomePut.Conflict(result.record)
	Protocol.Wire.SocketFrame.REFUSED -> HomePut.Refused(result.refusal)
	else -> HomePut.Uncertain(result.refusal ?: result.outcome)
}

internal const val PUT_APPLIED = "applied"
internal const val PUT_CONFLICT = "conflict"

/** The intake's answer, not the home's. */
private fun intakeAnswer(answer: JsonElement): JsonObject? = (answer as? JsonObject)?.takeIf { "opKey" in it || "malformed" in it }

/** Explicit nulls; the Gateway's schema needs them. */
private val sealedJson = Json(wireJson) { encodeDefaults = true }

/** Sole sealer, bound to Gateway and version. */
internal class AssistantHomeSealing(boot: PhoneBootstrap, ambient: PhoneAmbient, onMissingEpoch: (Int) -> Unit) :
	ContentSealing(boot, ambient, { gatewayId, version -> assistantHomeAadKind(gatewayId, version.toLong()) }, onMissingEpoch)

/** Each op one signed post. */
internal class OwnerOpHomeRouter(
	private val signAndPost: suspend (JsonObject) -> JsonElement?,
	private val sealing: () -> AssistantHomeSealing?,
) : AssistantHomeRouter {
	override suspend fun read(): AssistantHomeReadResult? {
		val answer = signAndPost(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_ASSISTANT_HOME_READ) }) ?: return null
		if (intakeAnswer(answer) != null) return null
		return runIsolated { wireJson.decodeFromJsonElement(AssistantHomeReadResult.serializer(), answer) }.getOrNull()
	}

	override suspend fun put(baseVersion: Long, gatewayId: String?, sealed: ContentEnvelope?): HomePut {
		val answer = signAndPost(
			buildJsonObject {
				put("kind", Protocol.Wire.OWNER_OP_ASSISTANT_HOME_PUT)
				put("baseVersion", baseVersion)
				put("gatewayId", gatewayId?.let(::JsonPrimitive) ?: JsonNull)
				put("sealed", sealed?.let { wireJson.encodeToJsonElement(ContentEnvelope.serializer(), it) } ?: JsonNull)
			},
		) ?: return HomePut.Uncertain(null)
		intakeAnswer(answer)?.let { intake ->
			val outcome = (intake["outcome"] as? JsonPrimitive)?.content ?: return HomePut.Uncertain(null)
			return homePutOf(AssistantHomePutResult(outcome = outcome, refusal = (intake["reason"] as? JsonPrimitive)?.content))
		}
		return runIsolated { wireJson.decodeFromJsonElement(AssistantHomePutResult.serializer(), answer) }.getOrNull()
			?.let(::homePutOf) ?: HomePut.Uncertain(null)
	}

	override fun seal(gatewayId: String, version: Long, sealed: AssistantHomeSealed): ContentEnvelope? =
		sealing()?.seal(sealedJson.encodeToString(AssistantHomeSealed.serializer(), sealed), gatewayId, version.toString())

	override fun open(gatewayId: String, version: Long, envelope: ContentEnvelope): AssistantHomeSealed? {
		val text = sealing()?.open(envelope, gatewayId, version.toString()) ?: return null
		return runIsolated { wireJson.decodeFromString(AssistantHomeSealed.serializer(), text) }.getOrNull()
	}
}
