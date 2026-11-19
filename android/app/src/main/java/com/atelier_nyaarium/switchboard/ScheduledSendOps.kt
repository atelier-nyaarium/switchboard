package com.atelier_nyaarium.switchboard

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
import kotlinx.coroutines.channels.Channel
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
	/** A draft's local files, each keeping its role; a gone one is skipped. */
	fun admitFiles(files: List<MessageFile>): Pair<List<OutgoingFile>, Admission.Refused?>
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
	private val provision: ProvisionFence,
) {
	private val scheduledSendMutex = Mutex()

	/** Term the pass began under. */
	private var began = 0L

	private suspend fun <T> pass(work: suspend () -> T): T = scheduledSendMutex.withLock {
		began = provision.capture()
		work()
	}

	/** Nothing lands after a re-provision. */
	private fun land(write: () -> Unit) {
		provision.land(began, write)
	}
	private val failurePositionLock = Any()
	private val failurePositions = LinkedHashMap<String, ReadAnchor>()
	var onScheduledSendFailed: ((team: String, opId: String) -> Unit)? = null

	suspend fun scheduleSend(team: String, text: String, files: List<MessageFile>, fireAtMillis: Long): Boolean = withContext(Dispatchers.IO) {
		if (!validTime(team, fireAtMillis)) return@withContext false
		if (files.size > Protocol.CHANNEL_FILES_MAX) { tell(team, scheduleFilesLine(Protocol.CHANNEL_FILES_MAX)); return@withContext false }
		val (picked, refused) = collaborators.admitFiles(files)
		if (refused != null) { tell(team, refused.message()); return@withContext false }
		val opId = java.util.UUID.randomUUID().toString()
		val fileRefs = Attachments.storeOutgoing(filesDir, "sched-$opId", picked)
		if (collaborators.fromCanonical(team) == null) { tell(team, Line.NO_ADDRESS.text); return@withContext false }
		pass {
			// Replacement names prior version.
			val prior = state.value.scheduledSends[team]
			put(team, ScheduledSend(text, fileRefs, fireAtMillis, opId, null, System.currentTimeMillis(), replacesVersion = prior?.routerVersion))
			prior?.let { collaborators.scheduleAttachmentDelete(it.fileRefs.mapNotNull(MessageFile::src)) }
		}
		kickDrain()
		true
	}

	fun rescheduleSend(team: String, fireAtMillis: Long): Boolean {
		if (!validTime(team, fireAtMillis)) return false
		repoScope.launch(Dispatchers.IO) {
			rescheduleNow(team, fireAtMillis)
			drainPending()
		}
		return true
	}

	/** Accepted records become replacements. */
	internal suspend fun rescheduleNow(team: String, fireAtMillis: Long) = pass {
		val prior = state.value.scheduledSends[team] ?: return@pass
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
	internal suspend fun cancelNow(team: String, edit: Boolean) = pass {
		val rec = state.value.scheduledSends[team] ?: return@pass
		if (edit && !rec.draftTaken) withSources(team, rec).let { files -> land { collaborators.takeBackIntoDraft(team, rec.text, files) } }
		if (rec.routerVersion == null) {
			remove(team, rec)
			if (!edit) deleteSourcesIfUnreferenced(team, rec)
			return@pass
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
		val answer = posted(team) { collaborators.postOwnerOp(op, "cancel:${rec.opId}") } ?: return
		val reason = answer.jsonObject["reason"]?.jsonPrimitive?.content
		val outcome = answer.jsonObject["outcome"]?.jsonPrimitive?.content
		when {
			outcome == Protocol.Wire.OP_OUTCOME_ACCEPTED -> {
				remove(team, rec)
				if (!rec.draftTaken) deleteSourcesIfUnreferenced(team, rec)
			}
			reason == SCHEDULE_SETTLED -> {
				// Its result row echoes or marks it.
				val settled = answer.jsonObject["state"]?.jsonPrimitive?.content
				remove(team, rec)
				if (settled == "cancelled" && !rec.draftTaken) deleteSourcesIfUnreferenced(team, rec)
				tell(team, settledSentence(settled))
			}
			outcome == SCHEDULE_CONFLICT -> {
				put(team, rec.copy(cancelRequested = false))
				tell(team, Line.SENDING_NOW.text)
			}
			else -> {
				remove(team, rec)
				tell(team, reasonSentence(Act.CANCELLING_SCHEDULED, reason))
			}
		}
	}

	/** A thrown post is told once, keyed; a later answer clears it. */
	private suspend fun posted(team: String, post: suspend () -> kotlinx.serialization.json.JsonElement?): kotlinx.serialization.json.JsonElement? {
		val answer = try {
			post()
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			tell(team, Line.SCHEDULE_UNREACHED.text)
			return null
		}
		if (answer != null) land { state.update { it.withoutNoticeKey(scheduledNoticeKey(team)) } }
		return answer
	}

	suspend fun drainPending() = pass {
		val ordered = state.value.scheduledSends.entries.sortedBy { it.value.createdAt }
		for ((team, rec) in ordered.filter { it.value.routerVersion == null }) {
			if (state.value.scheduledSends[team]?.opId != rec.opId) continue
			val target = collaborators.targetOf(team) ?: continue
			val files = try {
				rec.fileRefs.map { file -> if (file.blobId == null) file.copy(blobId = collaborators.uploadFile(file)) else file }
			} catch (e: Throwable) {
				e.rethrowIfCancellation()
				continue
			}
			val body = collaborators.sealScheduledBody(scheduledPlaintext(rec.text, rec.opId, files), rec.opId) ?: continue
			if (files != rec.fileRefs) put(team, rec.copy(fileRefs = files))
			val value = ScheduleSendValue(
				target = target,
				fireAt = rec.fireAtMillis,
				opId = rec.opId,
				files = files.mapNotNull { it.blobId },
				body = body,
				expectedVersion = rec.replacesVersion,
			)
			val answer = posted(team) {
				collaborators.postOwnerOp(wireJson.encodeToJsonElement(ScheduleSendValue.serializer(), value).jsonObject, rec.opId)
			} ?: continue
			val outcome = answer.jsonObject["outcome"]?.jsonPrimitive?.content
			val reason = answer.jsonObject["reason"]?.jsonPrimitive?.content
			val current = state.value.scheduledSends[team]?.takeIf { it.opId == rec.opId } ?: continue
			if (outcome != Protocol.Wire.OP_OUTCOME_ACCEPTED && reason == SCHEDULE_SETTLED) {
				// The replaced send finished; its result row echoes or marks it.
				val settled = answer.jsonObject["state"]?.jsonPrimitive?.content
				if (settled == "cancelled") takeBack(team, current, settledSentence(settled))
				else {
					remove(team, current)
					tell(team, settledSentence(settled))
				}
				continue
			}
			when (outcome) {
				Protocol.Wire.OP_OUTCOME_ACCEPTED -> {
					val version = answer.jsonObject["version"]?.jsonPrimitive?.long
					when (answer.jsonObject["state"]?.jsonPrimitive?.content) {
						// Echoes a prior fire.
						"fired" -> settle(team, current, Settle.Sent)
						"cancelled" -> settle(team, current, Settle.Cancelled)
						"error" -> settle(team, current, Settle.Failed(reason))
						else -> put(team, current.copy(routerVersion = version, replacesVersion = null))
					}
				}
				SCHEDULE_CONFLICT -> {
					val adopted = adoptRouterRecord(team)
					when {
						current.replacesVersion == null ->
							takeBack(team, current, if (adopted) Line.ANOTHER_SCHEDULED.text else Line.CHANGED_ELSEWHERE.text)
						// The replaced send is firing.
						!adopted -> {
							remove(team, current)
							tell(team, Line.SENDING_NOW.text)
						}
					}
				}
				Protocol.Wire.SocketFrame.REFUSED -> takeBack(team, current, reasonSentence(Act.SCHEDULING, reason))
			}
		}
		for ((team, rec) in ordered.filter { it.value.cancelRequested && it.value.routerVersion != null }) {
			if (state.value.scheduledSends[team]?.opId == rec.opId) postCancel(team, rec)
		}
		settlePastDue()
	}

	/** In memory, so a restart asks at once. */
	private val settleAsks = HashMap<String, SettleAsk>()

	/** Settles from the Router's record, row or not. */
	private suspend fun settlePastDue() {
		val now = System.currentTimeMillis()
		val held = state.value.scheduledSends.entries.filter { it.value.routerVersion != null && !it.value.cancelRequested }
		settleAsks.keys.retainAll(held.map { it.value.opId }.toSet())
		val due = held.filter { (_, rec) -> now >= (settleAsks[rec.opId] ?: firstSettleAsk(rec)).dueAt }
		if (due.isEmpty()) return
		val records = routerRecordsRead("settle:${java.util.UUID.randomUUID()}")
		for ((team, rec) in due) {
			if (records == null) {
				settleAsks[rec.opId] = nextSettleAsk(settleAsks[rec.opId] ?: firstSettleAsk(rec), now)
				continue
			}
			val current = state.value.scheduledSends[team]?.takeIf { it.opId == rec.opId } ?: continue
			when (val decided = settleFromRouter(current, records.firstOrNull { it.opId == rec.opId }, now)) {
				Settle.Wait -> settleAsks[rec.opId] = nextSettleAsk(settleAsks[rec.opId] ?: firstSettleAsk(rec), now)
				else -> {
					settleAsks.remove(rec.opId)
					settle(team, current, decided)
				}
			}
		}
	}

	/** The one settle road. */
	private suspend fun settle(team: String, rec: ScheduledSend, decided: Settle) {
		when (decided) {
			Settle.Wait -> Unit
			Settle.Sent -> {
				land { collaborators.append(team, Message(true, rec.text, rec.fireAtMillis, files = rec.fileRefs, opId = rec.opId)) }
				remove(team, rec)
				if (!rec.draftTaken) deleteSourcesIfUnreferenced(team, rec)
			}
			is Settle.Failed -> {
				val failed = Message(
					true,
					rec.text,
					rec.fireAtMillis,
					files = rec.fileRefs,
					status = "error",
					opId = failedSendOpId(rec.opId),
					failReason = reasonSentence(Act.SENDING_SCHEDULED, decided.reason),
				)
				land { collaborators.append(team, failed) }
				remove(team, rec)
				onScheduledSendFailed?.invoke(team, rec.opId)
			}
			Settle.Cancelled ->
				if (rec.draftTaken) remove(team, rec) else takeBack(team, rec, Line.CANCELLED_ELSEWHERE.text)
			Settle.Gone -> takeBack(team, rec, Line.CHANGED_ELSEWHERE.text)
		}
	}

	fun kickDrain() { repoScope.launch(Dispatchers.IO) { drainPending() } }

	/** One at a time, in row order. */
	private val results = Channel<Pair<ScheduledResultRow, ReadAnchor>>(Channel.UNLIMITED)

	init {
		repoScope.launch(Dispatchers.IO) {
			for ((row, position) in results) applyInOrder(row, position)
		}
	}

	fun onRouterResult(row: ScheduledResultRow, position: ReadAnchor) {
		results.trySend(row to position)
	}

	/** A throw costs one row. */
	private suspend fun applyInOrder(row: ScheduledResultRow, position: ReadAnchor) {
		try {
			applyRouterResult(row, position)
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			DebugLog.log("Scheduled", "result not applied: ${e.javaClass.simpleName}")
		} finally {
			resultsApplied.incrementAndGet()
		}
	}

	/** Taken off the queue. */
	internal val resultsApplied = java.util.concurrent.atomic.AtomicInteger()

	internal fun takeFailurePosition(opId: String): ReadAnchor? = synchronized(failurePositionLock) {
		failurePositions.remove(opId)
	}

	internal suspend fun applyRouterResult(row: ScheduledResultRow, position: ReadAnchor) = pass {
		val found = state.value.scheduledSends.entries.firstOrNull { it.value.opId == row.opId }
		when (row.outcome) {
			"pending" -> if (found == null) mirror(row)
			"sent" -> found?.let { (team, rec) ->
				land { collaborators.append(team, Message(true, rec.text, rec.fireAtMillis, files = rec.fileRefs, opId = rec.opId)) }
				remove(team, rec)
				if (!rec.draftTaken) deleteSourcesIfUnreferenced(team, rec)
			} ?: routerRecord(row.opId)?.let { (team, wire) -> echoRouter(team, wire) }
			"failed" -> {
				synchronized(failurePositionLock) {
					failurePositions[row.opId] = position
					while (failurePositions.size > 128) failurePositions.remove(failurePositions.keys.first())
				}
				val echoed = state.value.threads.entries.firstOrNull { (_, msgs) -> msgs.any { it.fromMe && it.opId == row.opId } }?.key
				when {
					echoed != null -> {
						found?.let { (_, rec) -> remove(echoed, rec) }
						val reason = reasonSentence(Act.SENDING_SCHEDULED, row.reason)
						land {
							state.update { s -> s.copy(threads = s.threads + (echoed to withFailedSend(s.threads[echoed].orEmpty(), row.opId, reason))) }
							persistence.persistThreads()
						}
						onScheduledSendFailed?.invoke(echoed, row.opId)
					}
					found != null -> settle(found.key, found.value, Settle.Failed(row.reason))
					else -> routerRecord(row.opId)?.let { (team, wire) -> echoRouter(team, wire) }
				}
			}
		}
	}

	/** Another device's send ended; once per thread. */
	private suspend fun echoRouter(team: String, wire: ScheduledRecord) {
		if (state.value.threads[team]?.any { it.opId == wire.opId || it.opId == failedSendOpId(wire.opId) } == true) return
		val (text, files) = decodedBody(wire) ?: return
		val firedAt = wire.fireAt
		when (wire.state) {
			"cancelled" -> Unit
			"error" -> {
				val failed = Message(
					true,
					text,
					firedAt,
					files = files,
					status = "error",
					opId = failedSendOpId(wire.opId),
					failReason = reasonSentence(Act.SENDING_SCHEDULED, wire.reason),
				)
				land { collaborators.append(team, failed) }
				onScheduledSendFailed?.invoke(team, wire.opId)
			}
			else -> land { collaborators.append(team, Message(true, text, firedAt, files = files, opId = wire.opId)) }
		}
	}

	/** Files with a local source as they are; Router-only ones fetched back, or dropped and named. */
	private suspend fun withSources(team: String, rec: ScheduledSend): List<MessageFile> {
		val fetched = rec.fileRefs.map { file -> if (file.src != null) file else collaborators.fetchFile(file, "sched-${rec.opId}") }
		val lost = rec.fileRefs.size - fetched.count { it != null }
		if (lost > 0) land { state.update { it.withNotice(lostFilesLine(lost), team = team) } }
		return fetched.filterNotNull()
	}

	/** The record leaves; its text and files go to the composer. */
	private suspend fun takeBack(team: String, rec: ScheduledSend, sentence: String) {
		remove(team, rec)
		val files = withSources(team, rec)
		land { collaborators.takeBackIntoDraft(team, rec.text, files) }
		tell(team, handedBack(sentence))
	}

	private suspend fun routerRecords(opId: String): List<ScheduledRecord> {
		val answer = collaborators.postOwnerOp(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_SCHEDULE_LIST) }, opId)
		// The list answers a bare array.
		val records = answer as? JsonArray ?: return emptyList()
		return records.mapNotNull { runIsolated { wireJson.decodeFromJsonElement<ScheduledRecord>(it) }.getOrNull() }
	}

	/** Null when unread, never gone. */
	private suspend fun routerRecordsRead(opId: String): List<ScheduledRecord>? {
		val answer = try {
			collaborators.postOwnerOp(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_SCHEDULE_LIST) }, opId)
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			return null
		}
		val records = answer as? JsonArray ?: return null
		return runIsolated { records.map { wireJson.decodeFromJsonElement<ScheduledRecord>(it) } }.getOrNull()
	}

	/** Adopts Router record. */
	private fun adopt(team: String, wire: ScheduledRecord): Boolean {
		val (text, files) = decodedBody(wire) ?: return false
		put(team, ScheduledSend(text, files, wire.fireAt, wire.opId, null, wire.createdAt, wire.version))
		return true
	}

	private fun decodedBody(wire: ScheduledRecord): Pair<String, List<MessageFile>>? {
		val plain = collaborators.openScheduledBody(wire.body, wire.opId) ?: return null
		val json = org.json.JSONObject(String(plain))
		val files = loadFiles(json).mapIndexed { index, file -> file.copy(src = null, blobId = wire.files.getOrNull(index)) }
		return json.optString("text") to files
	}

	/** Waiting only; a settled send is no dock. */
	private suspend fun mirror(row: ScheduledResultRow) {
		val (team, wire) = routerRecord(row.opId) ?: return
		if (wire.state == "armed" || wire.state == "firing") adopt(team, wire)
	}

	private suspend fun routerRecord(opId: String): Pair<String, ScheduledRecord>? {
		val wire = routerRecords(opId).firstOrNull { it.opId == opId } ?: return null
		val team = collaborators.teamOf(wire.target) ?: return null
		return team to wire
	}

	private suspend fun adoptRouterRecord(team: String): Boolean {
		val target = collaborators.targetOf(team) ?: return false
		val wire = routerRecords("resync:$team").firstOrNull { it.target == target && it.state == "armed" } ?: return false
		return adopt(team, wire)
	}

	private fun validTime(team: String, at: Long): Boolean {
		val now = System.currentTimeMillis()
		if (at <= now) tell(team, Line.TIME_PASSED.text)
		else if (at - now > ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS) tell(team, Line.TOO_FAR.text)
		return at > now && at - now <= ChatRepository.SCHEDULED_SEND_MAX_HORIZON_MS
	}

	private fun put(team: String, rec: ScheduledSend) = land { state.update { it.copy(scheduledSends = it.scheduledSends + (team to rec)) }; persistence.persistScheduledSends() }
	private fun remove(team: String, rec: ScheduledSend) = land { if (state.value.scheduledSends[team]?.opId == rec.opId) { state.update { it.copy(scheduledSends = it.scheduledSends - team) }; persistence.persistScheduledSends() } }
	private fun deleteSourcesIfUnreferenced(team: String, rec: ScheduledSend) { if (state.value.threads[team]?.any { it.opId == rec.opId } != true) collaborators.scheduleAttachmentDelete(rec.fileRefs.mapNotNull(MessageFile::src)) }
	/** One notice per send, in its conversation. */
	private fun tell(team: String, line: String) = state.update { it.withNotice(line, scheduledNoticeKey(team), team) }
}

internal const val SCHEDULE_SETTLED = "settled"
internal const val SCHEDULE_CONFLICT = "conflict"

/** The sealed plaintext the Router fires; `phone-encoded/cases.json` holds a case of it. */
internal fun scheduledPlaintext(text: String, opId: String, files: List<MessageFile>): ByteArray =
	org.json.JSONObject()
		.put("text", text)
		.put("messageId", opId)
		.put("files", org.json.JSONArray().also { a -> files.forEach { a.put(fileJson(it)) } })
		.toString()
		.toByteArray()

internal fun scheduledNoticeKey(team: String) = "scheduled:$team"

/** Past its time, a dock waits on the Router's result. */
internal fun scheduledSending(rec: ScheduledSend, now: Long): Boolean = now >= rec.fireAtMillis
