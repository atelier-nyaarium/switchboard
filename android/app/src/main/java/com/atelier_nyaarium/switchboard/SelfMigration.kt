package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.json.JSONObject

internal class SelfMigration(
	private val readAnchors: () -> Map<String, ReadAnchor>,
	private val journal: MutationJournal,
	private val reportRead: suspend (String, ReadAnchor) -> JsonElement?,
	private val resetAccepted: () -> Unit,
	private val reportError: (String) -> Unit = {},
) {
	private val runMutex = Mutex()

	suspend fun run(migrationEpoch: Long) = runMutex.withLock {
		if (migrationEpoch == 0L || journal.entries("self_migration").any { it.payload.optLong("migrationEpoch") == migrationEpoch }) return@withLock
		resetAccepted()
		var complete = true
		for ((team, anchor) in readAnchors()) {
			val answer = runCatching { reportRead(team, anchor) }.getOrNull()
			if (answer?.jsonObject?.get("outcome")?.jsonPrimitive?.content != com.atelier_nyaarium.switchboard.proto.Protocol.Wire.OP_OUTCOME_ACCEPTED) complete = false
		}
		if (complete) journal.append("self-migration-$migrationEpoch", "self_migration", JSONObject().put("migrationEpoch", migrationEpoch))
	}
}
