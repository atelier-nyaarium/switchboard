package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter
import com.atelier_nyaarium.switchboard.board.BoardSealing
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import com.atelier_nyaarium.switchboard.board.BoardRefusal
import com.atelier_nyaarium.switchboard.board.CardBranch
import com.atelier_nyaarium.switchboard.board.BoardIntent
import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.BoardStateAttachment
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.BoardReadResult
import com.atelier_nyaarium.switchboard.proto.BoardSession
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.File
import java.util.UUID
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface BoardOpsCollaborators {
	val board: BoardManager
	val sessions: SessionOps
	val attachmentHost: AttachmentHost
	val boardRouter: BoardRouterWriter
	fun boardSealing(): BoardSealing?
	fun admitPicked(uris: List<Uri>, name: String): Pair<List<OutgoingFile>, Admission.Refused?>
	fun localDomain(): String
	val client: ConsoleClient?
	fun command(block: suspend () -> Unit)
}

/** Repository-side board operations. */
internal class BoardOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val filesDir: File,
	private val collaborators: BoardOpsCollaborators,
) {
	/** Reads and drains the Router board. */
	fun refreshBoard() {
		repoScope.launch { readRouterBoard() }
	}

	private suspend fun readRouterBoard() {
		val sealing = collaborators.boardSealing() ?: return
		runCatchingCancellable {
			collaborators.boardRouter.read(java.util.UUID.randomUUID().toString()) {
				wireJson.decodeFromJsonElement(BoardReadResult.serializer(), it)
			}
			collaborators.boardRouter.drain(sealing)
		}.onFailure { DebugLog.log("Board", "router read/drain failed: ${it.message?.take(80)}") }
	}

	/** Assignable sessions on member Gateways; an assignment is intent the Router holds. */
	fun boardAssignTargets(): List<Team> {
		val members = state.value.gateways.ids().toSet()
		return state.value.teams.filter {
			it.kind != "console" && it.kind != "devcontainer" && (it.gatewayId.isEmpty() || it.gatewayId in members)
		}
	}

	/** Forgets a session and its board disposition. */
	fun forgetWithBoardDisposition(team: String, cancelThem: Boolean, onForgotten: () -> Unit) {
		val asked = if (cancelThem) "cancel" else "release"
		collaborators.sessions.forget(team, asked, onForgotten)
	}

	fun boardEntriesFor(team: String?): List<BoardEntry> = collaborators.board.routerEntries()

	fun boardLiveLineFor(team: String): BoardLiveLine? = collaborators.board.liveLine(team)

	fun boardUndoneCountFor(team: String): Int = collaborators.board.undoneCount(team)

	fun boardCardBranchFor(team: String, currentId: String?): CardBranch {
		val row = state.value.teams.firstOrNull { it.name == team } ?: return CardBranch(emptyList(), 0)
		val key = com.atelier_nyaarium.switchboard.board.GroupKey(row.domainId, row.gatewayId, collaborators.board.sessionKeyOf(team))
		return collaborators.board.cardBranch(key, currentId)
	}

	fun boardSessionKeyOf(team: String): String = collaborators.board.sessionKeyOf(team)

	/** The whole Router board. */
	fun boardEntries(): List<BoardEntry> = collaborators.board.routerEntries()

	fun boardLastSyncedAt(): Long = collaborators.board.lastSyncedAt()

	fun boardDismissRefusal(refusal: BoardRefusal) = collaborators.board.dismissRefusal(refusal)

	val boardRefusals get() = collaborators.board.refusals

	val boardRevision get() = collaborators.board.revision

	val knownBoardVersion get() = collaborators.board.knownVersion

	/** Queues an intent. */
	private fun intend(vararg intents: BoardIntent) {
		collaborators.board.enqueueWrite(intents.toList())
		repoScope.launch { readRouterBoard() }
	}

	/** Captures a root thought. */
	fun boardCapture(title: String, body: String?) {
		val last = collaborators.board.routerEntries()
			.filter { it.parent == null && it.trashedAt == null }
			.maxOfOrNull { it.rank }
		intend(
			BoardIntent.Create(
				id = UUID.randomUUID().toString().replace("-", "").take(32),
				title = title,
				body = body,
				state = "open",
				rank = com.atelier_nyaarium.switchboard.board.BoardRank.between(last, null),
			),
		)
	}

	fun boardSetState(id: String, state: String) = intend(BoardIntent.SetState(id, state))

	fun boardSetTitle(id: String, title: String) = intend(BoardIntent.SetTitle(id, title))

	fun boardSetBody(id: String, body: String?) = intend(BoardIntent.SetBody(id, body))

	/** Reparents and reranks an entry. */
	fun boardSetParent(id: String, parent: String?, rank: String) = intend(BoardIntent.SetParent(id, parent, rank))

	fun boardSetTrashed(id: String, trashed: Boolean) =
		intend(if (trashed) BoardIntent.Trash(id) else BoardIntent.Restore(id))

	/** Sets an entry's complete attachment list. */
	fun boardSetAttachments(id: String, keep: List<BoardAttachment>, add: List<Uri>) =
		collaborators.command { boardSetAttachmentsNow(id, keep, add) }

	private suspend fun boardSetAttachmentsNow(id: String, keep: List<BoardAttachment>, add: List<Uri>) {
		val bucket = Attachments.boardBucket(id)
		// Keep staged files outside the destination bucket.
		val (staged, refused) =
			if (add.isEmpty()) emptyList<OutgoingFile>() to null else collaborators.admitPicked(add, "pick-${UUID.randomUUID()}")
		if (refused != null) {
			state.update { it.copy(error = refused.message()) }
			return
		}
		// Limit count, not size.
		if (keep.size + staged.size > Protocol.BOARD_ATTACHMENTS_MAX) {
			collaborators.attachmentHost.cleanup(staged)
			state.update { it.copy(error = "An entry holds at most ${Protocol.BOARD_ATTACHMENTS_MAX} attachments") }
			return
		}
		val client = collaborators.attachmentHost.clientOrReject(staged) ?: return
		try {
			staged.forEach { client.uploadSealedBlob(it.source) }
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			state.update { it.copy(error = e.message ?: "Attachment upload failed") }
			return
		}
		val sources = mutableMapOf<String, String>()
		val added = staged.mapNotNull { picked ->
			// Land under the blob name.
			val blobId = client.blobIdOf(picked.source)
			val target = Attachments.boardFile(filesDir, id, blobId)
			target.parentFile?.mkdirs()
			picked.source.copyTo(target, overwrite = true)
			picked.source.delete()
			sources[blobId] = target.absolutePath
			BoardAttachment(
				blobId = blobId,
				filename = picked.name,
				mime = picked.mime,
				size = picked.size,
			)
		}
		// Supply every locally available member.
		for (a in keep) {
			val local = Attachments.boardFile(filesDir, id, a.blobId)
			if (local.isFile) sources[a.blobId] = local.absolutePath
		}
		// Remove only unreferenced landed files.
		val stays = (keep + added).mapTo(mutableSetOf()) { it.blobId }
		Attachments.boardBucketDir(filesDir, id).listFiles()?.forEach {
			if (it.name.startsWith("sha256-") && it.name !in stays) it.delete()
		}

		// Supplied means locally present.
		intend(
			BoardIntent.SetAttachments(
				id,
				(keep + added).map { BoardStateAttachment(it.blobId, it.size, it.mime) },
			),
		)
	}

	/** Returns or starts fetching an attachment. */
	fun boardAttachmentFile(entryId: String, a: BoardAttachment): File? {
		val landed = Attachments.boardFile(filesDir, entryId, a.blobId)
		if (landed.isFile) return landed
		// Auto-download small attachments only.
		if (a.size <= Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES) kickBoardDownload(entryId, a)
		return null
	}

	/** Explicitly downloads an attachment. */
	fun boardDownloadAttachment(entryId: String, a: BoardAttachment) {
		boardFetchFailures.remove(a.blobId)
		boardFetchAbsent.remove(a.blobId)
		kickBoardDownload(entryId, a)
	}

	private var lastForgetAt = 0L

	/** Re-asks absent attachments, at most once an hour. */
	fun forgetAbsent(now: Long = System.currentTimeMillis()) {
		if (now - lastForgetAt < AttachmentOps.ABSENT_RETRY_INTERVAL_MS) return
		lastForgetAt = now
		boardFetchFailures.clear()
		boardFetchAbsent.clear()
		collaborators.board.revision.longValue++
	}

	/** Attachment fetch state. */
	private val boardFetchFailures = java.util.Collections.synchronizedMap(mutableMapOf<String, Int>())
	private val boardDownloadsInFlight = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	private val boardFetchAbsent = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	fun boardAttachmentState(a: BoardAttachment): String = when {
		a.blobId in boardDownloadsInFlight -> "downloading"
		a.blobId in boardFetchAbsent -> "absent"
		(boardFetchFailures[a.blobId] ?: 0) >= ChatRepository.BOARD_FETCH_GIVE_UP -> "failed"
		a.size > Protocol.BOARD_AUTO_DOWNLOAD_MAX_BYTES -> "manual"
		else -> "pending"
	}

	private fun kickBoardDownload(entryId: String, a: BoardAttachment) {
		// Prefer this entry's pending wait.
		if ((boardFetchFailures[a.blobId] ?: 0) >= ChatRepository.BOARD_FETCH_GIVE_UP) return
		if (!boardDownloadsInFlight.add(a.blobId)) return
		repoScope.launch {
			try {
				val target = Attachments.boardFile(filesDir, entryId, a.blobId)
				val c = collaborators.client ?: error("Domain not yet confirmed by a local session")
				val staged = c.downloadBlob(a.blobId)
				target.parentFile?.mkdirs()
				// Land atomically through a temporary file.
				val tmp = File(target.parentFile, "${target.name}.landing")
				try {
					staged.copyTo(tmp, overwrite = true)
					if (!tmp.renameTo(target)) error("could not land ${a.filename}")
				} finally {
					// Remove partial output.
					tmp.delete()
				}
				// Discard the transfer buffer.
				c.forgetBlob(a.blobId)
				boardFetchFailures.remove(a.blobId)
				boardFetchAbsent.remove(a.blobId)
				collaborators.board.revision.longValue++
			} catch (e: BlobAbsent) {
				boardFetchAbsent.add(a.blobId)
				DebugLog.log("Board", "attachment ${a.blobId.take(16)} absent")
				collaborators.board.revision.longValue++
			} catch (e: Exception) {
				e.rethrowIfCancellation()
				// Ordinary failures do not prove absence.
				boardFetchAbsent.remove(a.blobId)
				// Bound repeated failures.
				boardFetchFailures[a.blobId] = (boardFetchFailures[a.blobId] ?: 0) + 1
				DebugLog.log("Board", "attachment fetch failed: ${e.message?.take(80)}")
				// Refresh the tile state.
				collaborators.board.revision.longValue++
			} finally {
				boardDownloadsInFlight.remove(a.blobId)
			}
		}
	}

	/** All board buckets on disk. */
	internal fun existingBoardBuckets(): Set<String> =
		Attachments.root(filesDir).listFiles()
			?.filter { it.isDirectory && it.name.startsWith("board-") }
			?.mapTo(mutableSetOf()) { it.name }
			?: emptySet()

	/** Whether the board decoded. */
	internal val boardIsKnown: Boolean get() = collaborators.board.boardIsKnown

	/** Live board attachment buckets. */
	internal fun attachmentBuckets(): Set<String>? = collaborators.board.attachmentBuckets()

	/** Assign an entry and its subtree to a session, or null back to the backlog. */
	fun boardAssign(id: String, team: String?) {
		// Assignment changes fields on one board.
		val session = team?.let { name ->
			val row = state.value.teams.firstOrNull { it.name == name }
			BoardSession(
				domainId = row?.domainId ?: collaborators.localDomain(),
				gatewayId = row?.gatewayId ?: return,
				sessionId = collaborators.board.sessionKeyOf(name),
			)
		}
		// Assign the subtree in one write.
		intend(*subtreeOf(id).map { BoardIntent.SetSession(it, session) }.toTypedArray())
	}

	/** Visited guard prevents cycles. */
	private fun subtreeOf(rootId: String): List<String> {
		val children = collaborators.board.routerEntries().groupBy { it.parent }
		val out = mutableListOf<String>()
		val seen = mutableSetOf<String>()
		val stack = ArrayDeque(listOf(rootId))
		while (stack.isNotEmpty()) {
			val id = stack.removeLast()
			if (!seen.add(id)) continue
			out.add(id)
			for (kid in children[id] ?: emptyList()) stack.addLast(kid.id)
		}
		return out
	}

}
