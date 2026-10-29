package com.atelier_nyaarium.switchboard

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun shedDeadAttachmentFailures(
	liveBlobIds: Set<String>,
	failures: MutableMap<String, Int>,
	failed: MutableStateFlow<Set<String>>,
) {
	failures.keys.removeIf { it !in liveBlobIds }
	failed.update { it intersect liveBlobIds }
}

/** Fetches attachment bytes and sweeps residue. */
internal interface AttachmentOpsCollaborators {
	fun clientOrNull(): ConsoleClient?
	fun attachmentBuckets(): Set<String>?
}

internal class AttachmentOps(
	private val state: MutableStateFlow<ChatState>,
	private val persistence: ChatPersistence,
	private val client: ClientPort,
	private val identity: IdentityPort,
	private val filesDir: File,
	private val scope: () -> CoroutineScope?,
	private val collaborators: AttachmentOpsCollaborators,
) {
	// Single-flight fetch guard.
	private val fetchingAttachments = java.util.concurrent.atomic.AtomicBoolean(false)

	// Failures counted per blob.
	private val attachmentFetchFailures = java.util.concurrent.ConcurrentHashMap<String, Int>()

	// Blobs at the retry limit.
	private val _failedAttachmentFetches = MutableStateFlow<Set<String>>(emptySet())
	val failedAttachmentFetches: StateFlow<Set<String>> = _failedAttachmentFetches

	/** Clears failures and retries. */
	fun retryAttachmentFetch(blobId: String) {
		attachmentFetchFailures.remove(blobId)
		_failedAttachmentFetches.update { it - blobId }
		fetchPendingAttachments()
	}

	private var lastForgetAt = 0L

	/** Re-asks abandoned fetches, at most once an hour. */
	fun forgetFailures(now: Long = System.currentTimeMillis()) {
		if (now - lastForgetAt < ABSENT_RETRY_INTERVAL_MS) return
		lastForgetAt = now
		attachmentFetchFailures.clear()
		_failedAttachmentFetches.value = emptySet()
	}

	companion object {
		const val ABSENT_RETRY_INTERVAL_MS = 60 * 60 * 1000L
	}

	/** Cold-start orphan sweep. Run before polling. */
	suspend fun sweepOrphanAttachments() = withContext(Dispatchers.IO) {
		val referencedSrcs = state.value.threads.values.asSequence()
			.flatMap { it.asSequence() }
			.flatMap { it.files.asSequence() }
			.map { it.src }
			.toList() + state.value.scheduledSends.values.flatMap { it.fileRefs }.map { it.src } +
			state.value.drafts.values.flatMap { it.files }.map { it.src }
		// Video frames have separate buckets.
		val frameBuckets = (
			state.value.threads.values.asSequence().flatMap { it.asSequence() }.flatMap { it.files.asSequence() } +
				state.value.drafts.values.asSequence().flatMap { it.files.asSequence() } +
				// Include banked-send videos.
				state.value.scheduledSends.values.asSequence().flatMap { it.fileRefs.asSequence() }
			)
			.filter { it.mime.startsWith("video/") }
			.mapNotNull { VideoThumbs.keyFor(it) }
			.map { VideoThumbs.bucketFor(it) }
			.toSet()
		// Unknown boards retain all board buckets.
		val keep = collaborators.attachmentBuckets()
		if (keep != null) Attachments.sweepOrphanBuckets(filesDir, referencedSrcs, frameBuckets + keep)
		// Prune staged blobs before polling.
		val freed = collaborators.clientOrNull()?.pruneStaleBlobs(ChatRepository.STALE_BLOB_MAX_AGE_MS) ?: 0L
		if (freed > 0) DebugLog.log("Attachments", "pruned $freed bytes of transfer residue")
	}

	/** Schedules background deletion. */
	fun scheduleAttachmentDelete(srcs: List<String>) {
		if (srcs.isEmpty()) return
		scope()?.launch(Dispatchers.IO) { Attachments.deleteFiles(filesDir, srcs) }
	}

	/** Fetches pending attachments one at a time. */
	fun fetchPendingAttachments() {
		val activeClient = collaborators.clientOrNull() ?: return
		// Release if dispatch cannot run.
		val activeScope = scope() ?: return
		if (!fetchingAttachments.compareAndSet(false, true)) return
		val job = activeScope.launch(Dispatchers.IO) {
			try {
				// Snapshot pending work.
				val pending = state.value.threads.flatMap { (team, msgs) ->
					msgs.flatMap { m ->
						m.files.filter { it.blobId != null && it.src == null }.map { Triple(team, m, it) }
					}
				}
				shedDeadAttachmentFailures(pending.mapNotNull { it.third.blobId }.toSet(), attachmentFetchFailures, _failedAttachmentFetches)
				for ((team, message, file) in pending) {
					val blobId = file.blobId ?: continue
					if (attachmentFetchFailures.getOrDefault(blobId, 0) >= ChatRepository.MAX_ATTACHMENT_FETCH_TRIES) continue
					val source = runCatchingCancellable {
						activeClient.downloadBlob(blobId)
					}
						.onFailure {
							// Count failures per blob.
							val tries = attachmentFetchFailures.getOrDefault(blobId, 0) + 1
							attachmentFetchFailures[blobId] = tries
							if (tries >= ChatRepository.MAX_ATTACHMENT_FETCH_TRIES) _failedAttachmentFetches.update { s -> s + blobId }
							DebugLog.log("Attachments", "fetch of ${file.name} failed ($tries): $it")
						}
						.getOrNull() ?: continue
					attachmentFetchFailures.remove(blobId)
					_failedAttachmentFetches.update { s -> s - blobId }
					val src =
						Attachments.land(filesDir, Attachments.bucketFor(message.epoch, message.seq), file.name, source)
							?: continue
					landFetchedAttachment(team, message.id, file.name, src)
					// Attachments bucket owns the landed bytes.
					activeClient.forgetBlob(blobId)
				}
			} finally {
				fetchingAttachments.set(false)
			}
		}
		// Release cancelled dispatches.
		job.invokeOnCompletion { fetchingAttachments.set(false) }
	}

	/** Lands fetched bytes; a cleared row's go. */
	private fun landFetchedAttachment(team: String, messageId: Long, name: String, src: String) {
		var landing = AttachmentLanding.Gone
		state.update { s ->
			val (outcome, next) = landedAttachment(s, team, messageId, name, src)
			landing = outcome
			next ?: s
		}
		when (landing) {
			AttachmentLanding.Landed -> persistence.persistThreads()
			AttachmentLanding.Gone -> Attachments.deleteFiles(filesDir, listOf(src))
			AttachmentLanding.Held -> {}
		}
	}
}

internal enum class AttachmentLanding { Landed, Held, Gone }

/** Held when nothing is owed or another row names `src`; Gone when nobody does. */
internal fun landedAttachment(state: ChatState, team: String, messageId: Long, name: String, src: String): Pair<AttachmentLanding, ChatState?> {
	val thread = state.threads[team].orEmpty()
	val idx = thread.indexOfFirst { it.id == messageId }
	if (idx < 0) {
		val named = src in state.namedSrcs(state.threads.values.flatten())
		return (if (named) AttachmentLanding.Held else AttachmentLanding.Gone) to null
	}
	val row = thread[idx]
	val files = row.files.map { if (it.name == name && it.src == null) it.copy(src = src) else it }
	if (files == row.files) return AttachmentLanding.Held to null
	val next = thread.toMutableList().also { it[idx] = row.copy(files = files) }
	return AttachmentLanding.Landed to state.copy(threads = state.threads + (team to next))
}
