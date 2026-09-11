package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ScheduleCancelValue
import com.atelier_nyaarium.switchboard.proto.ScheduleSendValue
import com.atelier_nyaarium.switchboard.proto.ScheduledRecord
import com.atelier_nyaarium.switchboard.proto.ScheduledResultRow
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

internal interface ScheduledSendOpsCollaborators {
	fun admitPicked(uris: List<Uri>, bucket: String): Pair<List<OutgoingFile>, Admission.Refused?>
	fun fromCanonical(team: String): String?
	fun scheduleAttachmentDelete(srcs: List<String>)
	fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>)
	/** In the thread state before it returns. */
	fun append(team: String, message: Message): Long
	suspend fun postOwnerOp(op: JsonObject, opId: String): kotlinx.serialization.json.JsonElement?
	fun sealScheduledBody(plaintext: ByteArray, opId: String): ContentEnvelope?
	fun openScheduledBody(body: ContentEnvelope, opId: String): ByteArray?
	fun targetOf(team: String): ScheduledTarget?
	fun teamOf(target: ScheduledTarget): String?
	suspend fun uploadFile(file: MessageFile): String
	/** The Router's bytes landed under `bucket`, or null. */
	suspend fun fetchFile(file: MessageFile, bucket: String): MessageFile?
}

internal class ScheduledSendOps(
	private val state: MutableStateFlow<ChatState>,
	private val persistence: ChatPersistence,
	private val filesDir: File,
	private val repoScope: CoroutineScope,
	private val collaborators: ScheduledSendOpsCollaborators,
) {
	private val scheduledSendMutex = Mutex()
	var onScheduledSendFailed: ((team: String, opId: String) -> Unit)? = null

	suspend fun scheduleSend(team: String, text: String, uris: List<Uri>, fireAtMillis: Long): Boolean = withContext(Dispatchers.IO) {
		if (!validTime(fireAtMillis)) return@withContext false
		val (picked, refused) = collaborators.admitPicked(uris, "pick-${java.util.UUID.randomUUID()}")
		if (refused != null) { state.update { it.copy(error = refused.message()) }; return@withContext false }
		val opId = java.util.UUID.randomUUID().toString()
		val fileRefs = Attachments.storeOutgoing(filesDir, "sched-$opId", picked)
		if (collaborators.fromCanonical(team) == null) { state.update { it.copy(error = "That session has no address to send to.") }; return@withContext false }
		scheduledSendMutex.withLock {
			// Replacement names prior version.
			val prior = state.value.scheduledSends[team]
			put(team, ScheduledSend(text, fileRefs, fireAtMillis, opId, null, System.currentTimeMillis(), replacesVersion = prior?.routerVersion))
			prior?.let { collaborators.scheduleAttachmentDelete(it.fileRefs.mapNotNull(MessageFile::src)) }
		}
		kickDrain()
		true
	}

	fun rescheduleSend(team: String, fireAtMillis: Long): Boolean {
		if (!validTime(fireAtMillis)) return false
		repoScope.launch(Dispatchers.IO) {
			rescheduleNow(team, fireAtMillis)
			drainPending()
		}
		return true
	}

	/** Accepted records become replacements. */
	internal suspend fun rescheduleNow(team: String, fireAtMillis: Long) = scheduledSendMutex.withLock {
		val prior = state.value.scheduledSends[team] ?: return@withLock
		put(
			team,
			if (prior.routerVersion == null) prior.copy(fireAtMillis = fireAtMillis)
			else prior.copy(
				fireAtMillis = fireAtMillis,
				opId = java.util.UUID.randomUUID().toString(),
				routerVersion = null,
				replacesVersion = prior.routerVersion,
				cancelRequested = false,
			),
		)
	}

	fun cancelScheduledSend(team: String) { repoScope.launch(Dispatchers.IO) { cancelNow(team, false) } }
	fun cancelScheduledSendForEdit(team: String) { repoScope.launch(Dispatchers.IO) { cancelNow(team, true) } }

	/** Accepted records become cancellations. */
	internal suspend fun cancelNow(team: String, edit: Boolean) = scheduledSendMutex.withLock {
		val rec = state.value.scheduledSends[team] ?: return@withLock
		if (edit && !rec.draftTaken) collaborators.takeBackIntoDraft(team, rec.text, withSources(rec))
		if (rec.routerVersion == null) {
			remove(team, rec)
			if (!edit) deleteSourcesIfUnreferenced(team, rec)
			return@withLock
		}
		val marked = rec.copy(cancelRequested = true, draftTaken = rec.draftTaken || edit)
		put(team, marked)
		postCancel(team, marked)
	}

	private suspend fun postCancel(team: String, rec: ScheduledSend) {
		val target = collaborators.targetOf(team) ?: return
		val version = rec.routerVersion ?: return
		val cancel = ScheduleCancelValue(target = target, expectedVersion = version)
		val op = wireJson.encodeToJsonElement(ScheduleCancelValue.serializer(), cancel).jsonObject
		val answer = collaborators.postOwnerOp(op, "cancel:${rec.opId}") ?: return
		val reason = answer.jsonObject["reason"]?.jsonPrimitive?.content
		when {
			answer.jsonObject["outcome"]?.jsonPrimitive?.content == Protocol.Wire.OP_OUTCOME_ACCEPTED -> {
				remove(team, rec)
				if (!rec.draftTaken) deleteSourcesIfUnreferenced(team, rec)
			}
			reason == "settled" -> {
				put(team, rec.copy(cancelRequested = false))
				setError("already sent")
			}
			else -> {
				remove(team, rec)
				setError(reason ?: "conflict")
			}
		}
	}

	suspend fun drainPending() = scheduledSendMutex.withLock {
		val ordered = state.value.scheduledSends.entries.sortedBy { it.value.createdAt }
		for ((team, rec) in ordered.filter { it.value.routerVersion == null }) {
			if (state.value.scheduledSends[team]?.opId != rec.opId) continue
			val target = collaborators.targetOf(team) ?: continue
			val files = try { rec.fileRefs.map { file -> if (file.blobId == null) file.copy(blobId = collaborators.uploadFile(file)) else file } } catch (_: Throwable) { continue }
			val plaintext = org.json.JSONObject().put("text", rec.text).put("messageId", rec.opId).put("files", org.json.JSONArray().also { a -> files.forEach { a.put(fileJson(it)) } }).toString().toByteArray()
			val body = collaborators.sealScheduledBody(plaintext, rec.opId) ?: continue
			if (files != rec.fileRefs) put(team, rec.copy(fileRefs = files))
			val value = ScheduleSendValue(
				target = target,
				fireAt = rec.fireAtMillis,
				opId = rec.opId,
				files = files.mapNotNull { it.blobId },
				body = body,
				expectedVersion = rec.replacesVersion,
			)
			val answer = collaborators.postOwnerOp(wireJson.encodeToJsonElement(ScheduleSendValue.serializer(), value).jsonObject, rec.opId)
			val outcome = answer?.jsonObject?.get("outcome")?.jsonPrimitive?.content
			val current = state.value.scheduledSends[team]?.takeIf { it.opId == rec.opId } ?: continue
			when (outcome) {
				Protocol.Wire.OP_OUTCOME_ACCEPTED -> {
					val version = answer.jsonObject["version"]?.jsonPrimitive?.long
					when (answer.jsonObject["state"]?.jsonPrimitive?.content) {
						// Echoes a prior fire.
						"fired" -> {
							collaborators.append(team, Message(true, current.text, System.currentTimeMillis(), files = current.fileRefs, opId = current.opId))
							remove(team, current)
						}
						"cancelled" -> takeBack(team, current, "cancelled elsewhere")
						"error" -> {
							remove(team, current)
							onScheduledSendFailed?.invoke(team, current.opId)
						}
						else -> put(team, current.copy(routerVersion = version, replacesVersion = null))
					}
				}
				"conflict" -> if (current.replacesVersion == null || !adoptRouterRecord(team)) takeBack(team, current, "conflict")
				Protocol.Wire.SocketFrame.REFUSED -> takeBack(team, current, answer.jsonObject["reason"]?.jsonPrimitive?.content ?: outcome)
			}
		}
		for ((team, rec) in ordered.filter { it.value.cancelRequested && it.value.routerVersion != null }) {
			if (state.value.scheduledSends[team]?.opId == rec.opId) postCancel(team, rec)
		}
	}

	fun kickDrain() { repoScope.launch(Dispatchers.IO) { drainPending() } }

	fun onRouterResult(row: ScheduledResultRow) { repoScope.launch(Dispatchers.IO) { applyRouterResult(row) } }

	internal suspend fun applyRouterResult(row: ScheduledResultRow) = scheduledSendMutex.withLock {
		val found = state.value.scheduledSends.entries.firstOrNull { it.value.opId == row.opId }
		when (row.outcome) {
			"pending" -> if (found == null) mirror(row)
			"sent" -> found?.let { (team, rec) ->
				collaborators.append(team, Message(true, rec.text, System.currentTimeMillis(), files = rec.fileRefs, opId = rec.opId))
				remove(team, rec)
				if (!rec.draftTaken) deleteSourcesIfUnreferenced(team, rec)
			}
			"failed" -> found?.let { (team, rec) -> remove(team, rec); onScheduledSendFailed?.invoke(team, rec.opId) }
		}
	}

	/** Files with a local source as they are; Router-only ones fetched back, or dropped and named. */
	private suspend fun withSources(rec: ScheduledSend): List<MessageFile> {
		val fetched = rec.fileRefs.map { file -> if (file.src != null) file else collaborators.fetchFile(file, "sched-${rec.opId}") }
		val lost = rec.fileRefs.size - fetched.count { it != null }
		if (lost > 0) setError("$lost attachment(s) could not be fetched back")
		return fetched.filterNotNull()
	}

	/** The record leaves; its text and files go to the composer. */
	private suspend fun takeBack(team: String, rec: ScheduledSend, reason: String?) {
		remove(team, rec)
		collaborators.takeBackIntoDraft(team, rec.text, withSources(rec))
		setError(reason)
	}

	private suspend fun routerRecords(opId: String): List<ScheduledRecord> {
		val answer = collaborators.postOwnerOp(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_SCHEDULE_LIST) }, opId)
		// The list answers a bare array.
		val records = answer as? JsonArray ?: return emptyList()
		return records.mapNotNull { runCatching { wireJson.decodeFromJsonElement<ScheduledRecord>(it) }.getOrNull() }
	}

	/** Adopts Router record. */
	private fun adopt(team: String, wire: ScheduledRecord): Boolean {
		val plain = collaborators.openScheduledBody(wire.body, wire.opId) ?: return false
		val json = org.json.JSONObject(String(plain))
		val files = loadFiles(json).mapIndexed { index, file -> file.copy(src = null, blobId = wire.files.getOrNull(index)) }
		put(team, ScheduledSend(json.optString("text"), files, wire.fireAt, wire.opId, null, wire.createdAt, wire.version))
		return true
	}

	private suspend fun mirror(row: ScheduledResultRow) {
		val wire = routerRecords(row.opId).firstOrNull { it.opId == row.opId } ?: return
		val team = collaborators.teamOf(wire.target) ?: return
		adopt(team, wire)
	}

	private suspend fun adoptRouterRecord(team: String): Boolean {
		val target = collaborators.targetOf(team) ?: return false
		val wire = routerRecords("resync:$team").firstOrNull { it.target == target && it.state == "armed" } ?: return false
		return adopt(team, wire)
	}

	private fun validTime(at: Long): Boolean {
		val now = System.currentTimeMillis()
		if (at <= now) state.update { it.copy(error = "That time has already passed - try scheduling again.") }
		else if (at - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS) state.update { it.copy(error = "Can't schedule more than 30 days out.") }
		return at > now && at - now <= ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS
	}

	private fun put(team: String, rec: ScheduledSend) { state.update { it.copy(scheduledSends = it.scheduledSends + (team to rec)) }; persistence.persistScheduledSends(state.value.scheduledSends) }
	private fun remove(team: String, rec: ScheduledSend) { if (state.value.scheduledSends[team]?.opId != rec.opId) return; state.update { it.copy(scheduledSends = it.scheduledSends - team) }; persistence.persistScheduledSends(state.value.scheduledSends) }
	private fun deleteSourcesIfUnreferenced(team: String, rec: ScheduledSend) { if (state.value.threads[team]?.any { it.opId == rec.opId } != true) collaborators.scheduleAttachmentDelete(rec.fileRefs.mapNotNull(MessageFile::src)) }
	private fun setError(reason: String?) { state.update { it.copy(error = "Scheduled send: ${reason ?: "unavailable"}") } }
}
