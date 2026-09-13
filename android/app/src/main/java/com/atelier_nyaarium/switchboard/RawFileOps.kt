package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Whole files open in the raw editor, and their drafts. Keyed by SESSION and path, as windows are.
 *
 * Held from the first editable read until left with nothing typed, so typing outlives the screen.
 */
internal class RawFileOps(
	private val host: WindowHost,
	private val drafts: WindowDraftStore,
) : ClearsOnReprovision {
	private val held = HeldEdits<RawEdit>(drafts)

	private val incarnations = AtomicLong(0)

	/** Moves on a re-provision, so a read in flight lands nothing after it. */
	private val epoch = AtomicLong(0)

	/** Counts each leave of a path, so an open still reading when its screen went lands nothing. */
	private val leaves = ConcurrentHashMap<Pair<WorkspaceTarget, String>, Long>()

	/** One save at a time, or a second tap sends text the first is still writing. */
	private val saving = Mutex()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	val edits: StateFlow<Map<WorkspaceTarget, List<RawEdit>>> = held.all

	/** Moves on a re-provision; a screen compares it before reopening a file it lost. */
	val generation: Long get() = epoch.get()

	fun editOf(target: WorkspaceTarget, path: String): RawEdit? = held.of(target).firstOrNull { it.path == path }

	private fun applyTo(target: WorkspaceTarget, incarnation: Long, transform: (RawEdit) -> RawEdit) =
		held.apply(target) { edits -> edits.map { if (it.incarnation == incarnation) transform(it) else it } }

	/**
	 * Lands only on the opening the work began from, still holding the hash it began from. A read that
	 * began before a save landed is older news than the save, and would put the old text back. Null lets
	 * the file go.
	 */
	private fun landUnmoved(target: WorkspaceTarget, stamp: RawStamp, transform: (RawEdit) -> RawEdit?) =
		held.apply(target) { edits -> edits.mapNotNull { if (it.stamp == stamp) transform(it) else it } }

	private suspend fun read(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> =
		host.workspace?.file(target, path) ?: WorkspaceAnswer.Unreachable

	/** Holds an editable file, restoring any draft. One already held is re-read against what it holds. */
	suspend fun open(target: WorkspaceTarget, path: String): WorkspaceAnswer<RawOpened> {
		val began = epoch.get()
		val leftBefore = leaves[target to path]
		val heldWhenAsked = editOf(target, path)?.stamp
		val file = when (val answer = read(target, path)) {
			is WorkspaceAnswer.Read -> answer.value
			is WorkspaceAnswer.Refused -> return answer
			WorkspaceAnswer.Unreachable -> return WorkspaceAnswer.Unreachable
		}
		if (heldWhenAsked != null) {
			landUnmoved(target, heldWhenAsked) { refreshRaw(it, file) }
			if (editOf(target, path) != null) return WorkspaceAnswer.Read(RawOpened.Editable)
			if (file.hash == null) return WorkspaceAnswer.Read(readOnlyOf(file))
			// Left during the read, so it is held afresh.
		}
		val edit = rawEditOf(path, file, incarnations.incrementAndGet())
			?: return WorkspaceAnswer.Read(readOnlyOf(file))
		val opened = restoredRaw(edit, drafts.load(target, DraftKey.File(path)))
		held.apply(target) { edits ->
			val wanted = epoch.get() == began && leaves[target to path] == leftBefore
			if (!wanted || edits.any { it.path == path }) edits else edits + opened
		}
		return WorkspaceAnswer.Read(RawOpened.Editable)
	}

	fun type(target: WorkspaceTarget, path: String, text: String) {
		val edit = editOf(target, path) ?: return
		applyTo(target, edit.incarnation) { it.copy(draft = text) }
	}

	/** Drops the typing and keeps the file open. */
	fun discard(target: WorkspaceTarget, path: String) {
		val edit = editOf(target, path) ?: return
		applyTo(target, edit.incarnation) { it.copy(draft = null) }
	}

	/** Leaving the screen lets go of a file with nothing typed. Typing stays held, and on disk. */
	fun leave(target: WorkspaceTarget, path: String) {
		leaves.merge(target to path, 1L, Long::plus)
		held.apply(target) { edits -> edits.filterNot { it.path == path && !it.edited } }
	}

	/** The banner's Refresh: the owner chose the file's text, so the draft goes. */
	suspend fun adopt(target: WorkspaceTarget, path: String): WorkspaceAnswer<RawOpened> {
		val current = editOf(target, path) ?: return open(target, path)
		val file = when (val answer = read(target, path)) {
			is WorkspaceAnswer.Read -> answer.value
			is WorkspaceAnswer.Refused -> return answer
			WorkspaceAnswer.Unreachable -> return WorkspaceAnswer.Unreachable
		}
		// Null when the file can no longer be edited, which lets it go.
		val next = rawEditOf(path, file, current.incarnation)
		// Typing or a save since the tap outranks it, and keeps the banner.
		val untouched = { edit: RawEdit -> edit.stamp == current.stamp && edit.draft == current.draft }
		held.apply(target) { edits -> edits.mapNotNull { if (untouched(it)) next else it } }
		val letGo = next == null && editOf(target, path) == null
		return WorkspaceAnswer.Read(if (letGo) readOnlyOf(file) else RawOpened.Editable)
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
						landUnmoved(target, edit.stamp) { written(it, sent, hash) }
						RawSave.Written
					}
					value.outcome == MUTATION_STALE -> {
						landUnmoved(target, edit.stamp) { it.copy(stale = true) }
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
				landUnmoved(target, edit.stamp) { written(it, sent, found.hash) }
				RawSave.Written
			}
			ReadBack.Untouched -> RawSave.NotWritten(reason)
			ReadBack.Moved -> {
				landUnmoved(target, edit.stamp) { refreshRaw(it, fresh) }
				RawSave.Stale(gone = false)
			}
		}
	}

	/** Unfenced, and guarded by the hash each file held when its read began. */
	suspend fun recheck(target: WorkspaceTarget) = sweeping.withLock {
		for ((path, stamp) in held.of(target).map { it.path to it.stamp }) {
			val fresh = (read(target, path) as? WorkspaceAnswer.Read)?.value ?: continue
			landUnmoved(target, stamp) { refreshRaw(it, fresh) }
		}
	}

	suspend fun recheckAll() {
		for (target in held.targets()) recheck(target)
	}

	/** A re-provision takes the previous owner's files with it, on disk as well as in memory. */
	override suspend fun clearInMemory() {
		epoch.incrementAndGet()
		leaves.clear()
		for (target in held.targets()) held.apply(target) { emptyList() }
		drafts.clearAll()
	}
}
