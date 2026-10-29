package com.atelier_nyaarium.switchboard

import android.net.Uri
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

/** `files` are local, a draft's or a staged screen's, and each keeps its role on the wire. */
suspend fun ChatRepository.send(team: String, text: String, files: List<MessageFile> = emptyList()): String? = withContext(Dispatchers.IO) {
	val (picked, refused) = rebuildFiles(files)
	if (refused != null) {
		DebugLog.log("Send", "admission refused before the wire: ${refused.message()}")
		_state.update { it.copy(transientMessages = it.transientMessages + refused.message()) }
		return@withContext null
	}
	// Bucket attachments by opId so concurrent sends cannot share deletion paths.
	val opId = java.util.UUID.randomUUID().toString()
	val localFiles = Attachments.storeOutgoing(filesDir, "out-$opId", picked)
	val echoId = append(
		team,
		Message(true, text, System.currentTimeMillis(), files = localFiles, status = "pending", opId = opId),
	)
	val row = _state.value.teams.firstOrNull { it.name == team }?.presence
	val wasAvailable = row != null && !row.isLive && !row.hasEnded
	// Cold wake notices are attempt-scoped. Only the raising send may clear them.
	val raisedWakeNotice = wasAvailable && !_state.value.awaitingWake(team)
	if (raisedWakeNotice) _state.update { it.copy(wakingTeams = it.wakingTeams + (team to System.currentTimeMillis())) }
	// From the row's own copies, so a source cleared meanwhile cannot fail the upload.
	deliver(team, echoId, text, rebuildFiles(localFiles).first, opId, raisedWakeNotice)
	opId
}

suspend fun ChatRepository.retrySend(team: String, messageId: Long, targetDomainOverride: String? = null) =
	withContext(Dispatchers.IO) {
		var claimed = false
		_state.update { s ->
			val thread = s.threads[team] ?: return@update s.also { claimed = false }
			val msg = thread.firstOrNull { it.id == messageId }
			if (msg == null || !msg.fromMe || msg.status != "error") {
				claimed = false
				s
			} else {
				claimed = true
				val retried = msg.copy(status = "pending", at = System.currentTimeMillis())
				s.copy(threads = s.threads + (team to (thread.filterNot { it.id == messageId } + retried)))
			}
		}
		if (!claimed) return@withContext
		val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return@withContext
		persistence.persistThreads()
		val (files, refused) = rebuildFiles(msg)
		if (refused != null) {
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(transientMessages = it.transientMessages + refused.message()) }
			return@withContext
		}
		if (msg.text.isBlank() && files.isEmpty()) {
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(transientMessages = it.transientMessages + "Attachments are no longer on this device; cannot retry.") }
			return@withContext
		}
		if (files.size < msg.files.size) {
			_state.update { it.copy(transientMessages = it.transientMessages + "Some attachments are no longer on this device; resending the rest.") }
		}
		deliver(team, messageId, msg.text, files, msg.opId ?: java.util.UUID.randomUUID().toString(), false, targetDomainOverride)
	}

internal suspend fun ChatRepository.deliver(
	team: String,
	echoId: Long,
	text: String,
	picked: List<OutgoingFile>,
	opId: String,
	raisedWakeNotice: Boolean,
	targetDomainOverride: String? = null,
) {
	var succeeded = false
	fun fail(message: String?) {
		_state.update { it.copy(transientMessages = it.transientMessages + (message ?: "send failed")) }
		setMessageStatus(team, echoId, "error")
	}
	try {
		// Board edits must reach the gateway before the message that reports them.
		try {
		} catch (e: Exception) {
			e.rethrowIfCancellation()
		}
		val targetDomain = targetDomainOverride ?: run {
			// Scheduled sends use their banked domain while the restored team list is empty.
			val adminDomain = readyOrNull()?.domainId
			val canonical = fromCanonical(team)
			_state.value.teams
				.firstOrNull { it.name == canonical }
				?.domainId
				?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
		}
		DebugLog.log("Send", "op=${opId.take(8)} team=$team files=${picked.size} domain=${targetDomain ?: "local"}")
		val r = client().send(team, text, picked, opId, targetDomain)
		when {
			!r.ok -> {
				DebugLog.log("Send", "op=${opId.take(8)} refused: ${r.error?.take(160)}")
				fail(r.error)
			}
			else -> {
				DebugLog.log("Send", "op=${opId.take(8)} ok")
				succeeded = true
				setMessageStatus(team, echoId, null)
			}
		}
	} catch (e: Exception) {
		// Cancellation must remain pending so reconciliation can retry it.
		e.rethrowIfCancellation()
		// Use the shared classifier so users see a connection cause, not raw transport text.
		val (cause, _) = classifyConnError(e)
		DebugLog.log("Send", "op=${opId.take(8)} threw: ${e::class.simpleName}: ${e.message?.take(160)}")
		fail(cause)
	} finally {
		// Clear wake state on failed or cancelled attempts, but preserve successful notices.
		if (!succeeded && raisedWakeNotice) _state.update { it.copy(wakingTeams = it.wakingTeams - team) }
	}
}

private fun ChatRepository.rebuildFiles(msg: Message): Pair<List<OutgoingFile>, Admission.Refused?> = rebuildFiles(msg.files)

internal fun ChatRepository.rebuildFiles(files: List<MessageFile>): Pair<List<OutgoingFile>, Admission.Refused?> {
	val admitted = mutableListOf<OutgoingFile>()
	var blocker: Admission.Refused? = null
	for (a in OutgoingFiles.admitAll(files, filesDir)) {
		when (a) {
			is Admission.Granted -> admitted += a.file
			// Missing files are survivable. Size refusals must not silently drop attachments.
			is Admission.Refused ->
				if (a.reason == Admission.Reason.GONE) Unit else if (blocker == null) blocker = a
		}
	}
	return admitted to blocker
}

fun ChatRepository.cancelFailedSend(team: String, messageId: Long) {
	val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return
	if (!msg.fromMe || msg.status != "error") return
	val refs = msg.files.filter { Attachments.fileFor(filesDir, it.src) != null }
	takeBackIntoDraft(team, msg.text, refs)
	removeMessage(team, messageId)
}

private fun ChatRepository.removeMessage(team: String, id: Long) {
	_state.update { s ->
		val thread = s.threads[team] ?: return@update s
		s.copy(threads = s.threads + (team to thread.filterNot { it.id == id }))
	}
	persistence.persistThreads()
}

private fun ChatRepository.setMessageStatus(team: String, id: Long, status: String?) {
	_state.update { s ->
		val thread = s.threads[team] ?: return@update s
		s.copy(threads = s.threads + (team to thread.map { if (it.id == id) it.copy(status = status) else it }))
	}
	persistence.persistThreads()
}

/** A shared screen in its own bucket, as `screen` files [send] admits with the rest. Blocks on disk. */
internal fun ChatRepository.stageScreen(png: ByteArray?, text: String?): List<MessageFile> {
	val bucket = "pick-${java.util.UUID.randomUUID()}"
	val dir = File(Attachments.root(filesDir), bucket)
	val parts = listOfNotNull(
		png?.let { Triple("screen.png", "image/png", it) },
		text?.takeIf { it.isNotBlank() }?.let { Triple("screen.txt", "text/plain", it.toByteArray()) },
	)
	return parts.mapNotNull { (name, mime, bytes) ->
		runIsolated { File(dir.apply { mkdirs() }, name).writeBytes(bytes) }
			.onFailure { DebugLog.log("Send", "screen $name not staged: ${it.javaClass.simpleName}") }
			.getOrNull() ?: return@mapNotNull null
		MessageFile(name, mime, "${Attachments.assetBase()}/$bucket/$name", bytes.size.toLong(), role = ROLE_SCREEN)
	}
}

internal fun ChatRepository.admitPicked(uris: List<Uri>, bucket: String): Pair<List<OutgoingFile>, Admission.Refused?> {
	val staged = mutableListOf<OutgoingFile>()
	val dir = File(Attachments.root(filesDir), bucket)
	var running = 0L
	for ((i, uri) in uris.withIndex()) {
		when (val a = attachmentHost.admit(uri, File(dir, "staged-$i"))) {
			is Admission.Refused -> {
				attachmentHost.cleanup(staged)
				return emptyList<OutgoingFile>() to a
			}
			is Admission.Granted -> {
				running += a.file.size
				if (running > ChatRepository.MAX_OUTGOING_BYTES) {
					attachmentHost.cleanup(staged + a.file)
					return emptyList<OutgoingFile>() to
						Admission.Refused(a.file.name, Admission.Reason.OVER_TRANSPORT, running, ChatRepository.MAX_OUTGOING_BYTES)
				}
				staged += a.file
			}
		}
	}
	return staged to null
}

suspend fun ChatRepository.reconcilePending() = withContext(Dispatchers.IO) {
	// Reuse the original opId so landed sends cannot duplicate.
	val stillPending = _state.value.threads.flatMapTo(mutableSetOf()) { (team, msgs) ->
		msgs.filter { it.fromMe && it.status == "pending" }.map { "$team:${it.id}" }
	}
	reconciled.retainAll(stillPending)
	for ((team, msgs) in _state.value.threads) {
		for (m in msgs) {
			if (!m.fromMe || m.status != "pending") continue
			val key = "$team:${m.id}"
			if (!reconciled.add(key)) continue
			if (m.opId == null) {
				// Legacy rows without an opId cannot be safely re-sent.
				setMessageStatus(team, m.id, "error")
				continue
			}
			val (rebuilt, refusedRow) = rebuildFiles(m)
			if (refusedRow != null) {
				setMessageStatus(team, m.id, "error")
				DebugLog.log("Reconcile", "re-send of $key refused: ${refusedRow.reason}")
				continue
			}
			try {
				deliver(team, m.id, m.text, rebuilt, m.opId, false)
			} catch (e: CancellationException) {
				// A cancelled pending row must be eligible for the next reconciliation.
				reconciled.remove(key)
				throw e
			} catch (e: Throwable) {
				// Settle unexpected errors as retriable so one row cannot crash-loop the app.
				setMessageStatus(team, m.id, "error")
				DebugLog.log("Reconcile", "re-send of $key failed non-retriably: $e")
			}
		}
	}
}
