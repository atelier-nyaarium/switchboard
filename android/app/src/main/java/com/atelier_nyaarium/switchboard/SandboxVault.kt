package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultEntryClear
import com.atelier_nyaarium.switchboard.proto.VaultListResult
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.proto.VaultWriteResult
import com.atelier_nyaarium.switchboard.vault.VaultManager
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

private const val VAULT_ROUND_TRIP_MS = 400L

/** Requests the sandbox refuses, with the code. */
internal val SANDBOX_VAULT_REFUSALS = mapOf(
	"sandbox-sudo-refused" to Protocol.Wire.VaultAnswerRefusalCode.BOUND_ELSEWHERE.wire,
)

internal fun sandboxVaultOwnerOp(manager: VaultManager, op: JsonObject, now: Long): JsonElement {
	val snapshot = manager.snapshot()
	return when (op["kind"]?.jsonPrimitive?.contentOrNull) {
		Protocol.Wire.OWNER_OP_VAULT_LIST -> {
			val since = op["sinceRevision"]?.jsonPrimitive?.longOrNull
			wireJson.encodeToJsonElement(
				VaultListResult.serializer(),
				VaultListResult(
					revision = snapshot.revision,
					since = since ?: 0L,
					entries = snapshot.stored.filter { since == null || it.clear.changedAt > since },
				),
			)
		}
		Protocol.Wire.OWNER_OP_VAULT_PUT -> {
			val put = op["put"]?.let { runIsolated { wireJson.decodeFromJsonElement<VaultPut>(it) }.getOrNull() }
				?: return wireJson.encodeToJsonElement(
					VaultWriteResult.serializer(),
					VaultWriteResult(Protocol.Wire.OP_OUTCOME_REFUSED, snapshot.revision, refusal = Protocol.Wire.OP_OUTCOME_REFUSED),
				)
			val held = snapshot.stored.firstOrNull { it.clear.id == put.id }
			val current = held?.clear?.revision ?: 0L
			if (put.expectedRevision != current) {
				wireJson.encodeToJsonElement(
					VaultWriteResult.serializer(),
					VaultWriteResult(Protocol.Wire.OP_OUTCOME_REFUSED, snapshot.revision, refusal = Protocol.Wire.OP_OUTCOME_REFUSED),
				)
			} else {
				val revision = snapshot.revision + 1L
				val entry = VaultStoredEntry(
					clear = VaultEntryClear(
						id = put.id,
						revision = current + 1L,
						tombstone = false,
						changedAt = revision,
						createdBy = held?.clear?.createdBy ?: "phone",
						createdAt = held?.clear?.createdAt ?: now,
						updatedAt = now,
					),
					sealed = put.sealed,
				)
				wireJson.encodeToJsonElement(
					VaultWriteResult.serializer(),
					VaultWriteResult(Protocol.Wire.BOARD_OUTCOME_APPLIED, revision, entry),
				)
			}
		}
		Protocol.Wire.OWNER_OP_VAULT_DELETE -> {
			val id = op["id"]?.jsonPrimitive?.contentOrNull
			val expected = op["expectedRevision"]?.jsonPrimitive?.longOrNull
			val held = id?.let { key -> snapshot.stored.firstOrNull { it.clear.id == key && !it.clear.tombstone } }
			val result = when {
				held == null || expected == null -> VaultWriteResult(
					Protocol.Wire.OP_OUTCOME_REFUSED,
					snapshot.revision,
					refusal = Protocol.Wire.OP_OUTCOME_REFUSED,
				)
				held.clear.revision != expected -> VaultWriteResult(
					Protocol.Wire.OP_OUTCOME_REFUSED,
					snapshot.revision,
					refusal = Protocol.Wire.OP_OUTCOME_REFUSED,
				)
				else -> {
					val revision = snapshot.revision + 1L
					VaultWriteResult(
						Protocol.Wire.BOARD_OUTCOME_APPLIED,
						revision,
						held.copy(clear = held.clear.copy(revision = held.clear.revision + 1, tombstone = true, changedAt = revision, updatedAt = now)),
					)
				}
			}
			wireJson.encodeToJsonElement(VaultWriteResult.serializer(), result)
		}
		else -> error("unsupported sandbox vault op")
	}
}

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
