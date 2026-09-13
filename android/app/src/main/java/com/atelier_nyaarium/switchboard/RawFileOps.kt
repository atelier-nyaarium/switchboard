package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Whole files open in the raw editor, their drafts, and what each screen draws. Keyed by SESSION and path,
 * as windows are.
 *
 * Held from the first editable read until left with nothing typed, so typing outlives the screen. The view
 * is decided here rather than in the screen, since no gate reaches a Composable.
 */
internal class RawFileOps(
	private val host: WorkspaceHost,
	private val drafts: WorkspaceDraftStore,
) : ClearsOnReprovision {
	private val held = HeldEdits<RawEdit>(drafts)

	private val drawn = MutableStateFlow<Map<Pair<WorkspaceTarget, String>, RawView>>(emptyMap())

	private val incarnations = AtomicLong(0)

	/**
	 * The one open of each path that may still land. A newer open or a leave replaces or drops it, so an older
	 * read settles nothing, and it goes when that open settles.
	 */
	private val opening = ConcurrentHashMap<Pair<WorkspaceTarget, String>, Any>()

	/** One save at a time, or a second tap sends text the first is still writing. */
	private val saving = Mutex()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	val edits: StateFlow<Map<WorkspaceTarget, List<RawEdit>>> = held.all

	/** What each open file's screen draws. Absent: no screen has asked, or it left. */
	val views: StateFlow<Map<Pair<WorkspaceTarget, String>, RawView>> = drawn

	fun editOf(target: WorkspaceTarget, path: String): RawEdit? = held.of(target).firstOrNull { it.path == path }

	fun viewOf(target: WorkspaceTarget, path: String): RawView? = drawn.value[target to path]

	private fun edit(target: WorkspaceTarget, path: String, change: (RawEdit) -> RawEdit) =
		held.apply(target) { edits -> edits.map { if (it.path == path) change(it) else it } }

	/** Replaces the view of a screen still showing, and only that. */
	private fun redraw(target: WorkspaceTarget, path: String, view: RawView) {
		drawn.update { all -> if ((target to path) in all) all + ((target to path) to view) else all }
	}

	private suspend fun read(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> =
		host.workspace?.file(target, path) ?: WorkspaceAnswer.Unreachable

	/**
	 * Holds an editable file, restoring any draft, and draws what it is. One already held is re-read against
	 * what it holds. Nothing lands for a screen that left, or across a re-provision, while this read.
	 */
	suspend fun open(target: WorkspaceTarget, path: String): RawView {
		val key = target to path
		val began = host.generation.capture()
		val mine = Any()
		opening[key] = mine
		val wanted = { host.generation.isCurrent(began) && opening[key] === mine }
		val settle = { view: RawView ->
			drawn.update { all -> if (wanted()) all + (key to view) else all }
			view
		}
		try {
			drawn.update { all -> if (key in all) all else all + (key to RawView.Loading) }
			val before = editOf(target, path)
			val answer = read(target, path)
			val file = (answer as? WorkspaceAnswer.Read)?.value
			if (file == null) {
				// Held typing stays on screen; a failed read is no reason to hide it.
				return settle(if (editOf(target, path) != null) RawView.Editable else rawViewOf(answer) ?: RawView.Unreachable)
			}
			if (before != null) {
				held.land(target, before, Landing.Folded { refreshRaw(it, file) })
				if (editOf(target, path) != null) return settle(RawView.Editable)
				if (file.hash == null) return settle(readOnlyOf(file))
				// Left during the read, so it is held afresh.
			}
			val edit = rawEditOf(path, file, incarnations.incrementAndGet()) ?: return settle(readOnlyOf(file))
			val opened = restoredRaw(edit, drafts.load(target, DraftKey.File(path)))
			held.apply(target) { edits -> if (!wanted() || edits.any { it.path == path }) edits else edits + opened }
			return settle(RawView.Editable)
		} finally {
			opening.remove(key, mine)
		}
	}

	/** Memory only; the disk follows from the value. A caret move is not typing. */
	fun type(target: WorkspaceTarget, path: String, text: String) {
		edit(target, path) { if (it.shown == text) it else it.copy(draft = text) }
	}

	/** Drops the typing and keeps the file open. */
	fun discard(target: WorkspaceTarget, path: String) {
		edit(target, path) { it.copy(draft = null) }
	}

	/** Leaving the screen lets go of a file with nothing typed. Typing stays held, and on disk. */
	fun leave(target: WorkspaceTarget, path: String) {
		opening.remove(target to path)
		held.apply(target) { edits -> edits.filterNot { it.path == path && !it.edited } }
		drawn.update { it - (target to path) }
	}

	/**
	 * The banner's Refresh: the owner chose the file's text, so the draft goes. Answers a notice when the file
	 * could not be read, which leaves the editor and its typing on screen.
	 */
	suspend fun adopt(target: WorkspaceTarget, path: String): String? {
		val tapped = editOf(target, path) ?: return refreshNotice(open(target, path))
		val answer = read(target, path)
		val file = (answer as? WorkspaceAnswer.Read)?.value ?: return refreshNotice(rawViewOf(answer))
		// Null when the file can no longer be edited, which lets it go.
		val next = rawEditOf(path, file, tapped.incarnation)
		// Typing or a save since the tap outranks it, and keeps the banner.
		val landed = held.land(target, tapped, Landing.OverUntouched(next))
		if (landed && next == null) redraw(target, path, readOnlyOf(file))
		return null
	}

	/** Only while the file still hashes to what the owner was shown. An unanswered write is read back. */
	suspend fun save(target: WorkspaceTarget, path: String): RawSave = saving.withLock {
		val edit = editOf(target, path)?.takeIf { it.edited } ?: return@withLock RawSave.NothingEdited
		val gate = host.workspace ?: return@withLock RawSave.NotWritten(null)
		val sent = edit.shown
		val answer = try {
			gate.mutateFile(target, WorkspaceFileMutation.Write(path = path, expectedHash = edit.hash, text = sent))
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("RawFile", "save failed: ${e.message}")
			WorkspaceAnswer.Unreachable
		}
		when (answer) {
			is WorkspaceAnswer.Read -> {
				val value = answer.value
				val hash = value.hash
				when {
					value.outcome == MUTATION_DONE && hash != null -> {
						held.land(target, edit, Landing.Folded { written(it, sent, hash) })
						RawSave.Written
					}
					value.outcome == MUTATION_STALE -> {
						held.land(target, edit, Landing.Folded { it.copy(stale = true) })
						RawSave.Stale(gone = value.gone == true)
					}
					// Includes an outcome this build does not know, which may have written.
					else -> readBack(target, edit, sent, value.reason)
				}
			}
			is WorkspaceAnswer.Refused -> RawSave.Refused(answer.reason)
			WorkspaceAnswer.Unreachable -> readBack(target, edit, sent, null)
		}
	}

	private suspend fun readBack(target: WorkspaceTarget, edit: RawEdit, sent: String, reason: String?): RawSave {
		val fresh = (read(target, edit.path) as? WorkspaceAnswer.Read)?.value ?: return RawSave.Unconfirmed
		return when (val found = readBackOf(sent, edit.hash, fresh)) {
			is ReadBack.Landed -> {
				held.land(target, edit, Landing.Folded { written(it, sent, found.hash) })
				RawSave.Written
			}
			ReadBack.Untouched -> RawSave.NotWritten(reason)
			ReadBack.Moved -> {
				held.land(target, edit, Landing.Folded { refreshRaw(it, fresh) })
				RawSave.Stale(gone = false)
			}
		}
	}

	/** Unfenced: each file's answer lands only on the opening and version its read began from. */
	suspend fun recheck(target: WorkspaceTarget) = sweeping.withLock {
		for (before in held.of(target)) {
			val fresh = (read(target, before.path) as? WorkspaceAnswer.Read)?.value ?: continue
			val landed = held.land(target, before, Landing.Folded { refreshRaw(it, fresh) })
			// Let go, since it can no longer be written, so its screen shows it read-only.
			if (landed && fresh.hash == null && editOf(target, before.path) == null) {
				redraw(target, before.path, readOnlyOf(fresh))
			}
		}
	}

	suspend fun recheckAll() {
		for (target in held.targets()) recheck(target)
	}

	/** A re-provision takes the previous owner's files with it, on disk as well as in memory. */
	override suspend fun clearInMemory() {
		opening.clear()
		drawn.value = emptyMap()
		for (target in held.targets()) held.apply(target) { emptyList() }
		drafts.clearAll()
	}
}
