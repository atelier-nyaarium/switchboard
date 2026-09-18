package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where a read of one open file began. */
private typealias RawTicket = PublishedViews.ReadTicket<Pair<WorkspaceTarget, String>>

/** Debounces a paint request per key, so only the newest survives its wait. */
internal interface RawPaintTimer {
	fun debounce(key: Any, delayMs: Long, task: suspend () -> Unit)
}

/** The paint reaches the plugin, so a dead session throws here. Without this the process goes down. */
internal class CoroutinePaintTimer : RawPaintTimer {
	private val scope = CoroutineScope(
		SupervisorJob() + Dispatchers.IO +
			CoroutineExceptionHandler { _, e ->
				DebugLog.log("RawFile", "uncaught in paint timer: ${e.javaClass.simpleName}: ${e.message}")
			},
	)
	private val jobs = ConcurrentHashMap<Any, Job>()

	override fun debounce(key: Any, delayMs: Long, task: suspend () -> Unit) {
		jobs.put(key, scope.launch { delay(delayMs); task() })?.cancel()
	}
}

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
	private val paintTimer: RawPaintTimer,
) : ClearsOnReprovision {
	private val held = HeldEdits<RawEdit>(drafts)

	/** Each open is a new showing, so an older open's read settles nothing. */
	private val shown = PublishedViews<Pair<WorkspaceTarget, String>, RawView>(host.generation)

	/** As `shown`, for the paint a screen draws over the held text. */
	private val painted = PublishedViews<Pair<WorkspaceTarget, String>, RawPaint>(host.generation)

	private val incarnations = AtomicLong(0)

	/** One save at a time, or a second tap sends text the first is still writing. */
	private val saving = Mutex()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	val edits: StateFlow<Map<WorkspaceTarget, List<RawEdit>>> = held.all

	/** What each open file's screen draws. Absent: no screen has asked, or it left. */
	val views: StateFlow<Map<Pair<WorkspaceTarget, String>, RawView>> = shown.all

	/** What each open file's screen paints. Absent: nothing painted yet, or it left. */
	val paints: StateFlow<Map<Pair<WorkspaceTarget, String>, RawPaint>> = painted.all

	fun editOf(target: WorkspaceTarget, path: String): RawEdit? = held.of(target).firstOrNull { it.path == path }

	val unsaved: StateFlow<Set<String>> = held.unsaved

	fun isUnsaved(unsaved: Set<String>, target: WorkspaceTarget, edit: RawEdit): Boolean =
		held.isUnsaved(unsaved, target, edit)

	fun viewOf(target: WorkspaceTarget, path: String): RawView? = shown.of(target to path)

	fun paintOf(target: WorkspaceTarget, path: String): RawPaint? = painted.of(target to path)

	private fun edit(target: WorkspaceTarget, path: String, change: (RawEdit) -> RawEdit) =
		held.apply(target) { edits -> edits.map { if (it.path == path) change(it) else it } }

	/** Replaces the view of a screen still showing, and only that. */
	private fun redraw(ticket: RawTicket?, view: RawView) {
		if (ticket != null) shown.update(ticket) { view }
	}

	private suspend fun read(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> =
		host.workspace?.file(target, path) ?: WorkspaceAnswer.Unreachable

	/**
	 * Holds an editable file, restoring any draft, and draws what it is. One already held is re-read against
	 * what it holds. Nothing lands for a screen that left, or across a re-provision, while this read.
	 */
	suspend fun open(target: WorkspaceTarget, path: String): RawView {
		val view = openFile(target, path)
		if (view == RawView.Editable) startPaint(target, path)
		return view
	}

	private suspend fun openFile(target: WorkspaceTarget, path: String): RawView {
		val showing = shown.reshow(target to path) { RawView.Loading }
		val ticket = shown.ticket(showing)
		val settle = { view: RawView ->
			shown.update(ticket) { view }
			view
		}
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
		held.apply(target) { edits -> if (!shown.isCurrent(showing) || edits.any { it.path == path }) edits else edits + opened }
		return settle(RawView.Editable)
	}

	/** Memory only; the disk follows from the value. A caret move is not typing. */
	fun type(target: WorkspaceTarget, path: String, text: String) {
		edit(target, path) { if (it.shown == text) it else it.copy(draft = text) }
		syncPaint(target, path)
	}

	/** Drops the typing and keeps the file open. */
	fun discard(target: WorkspaceTarget, path: String) {
		edit(target, path) { it.copy(draft = null) }
		syncPaint(target, path)
	}

	/** Leaving the screen lets go of a file with nothing typed. Typing stays held, and on disk. */
	fun leave(target: WorkspaceTarget, path: String) {
		shown.leave(target to path)
		painted.leave(target to path)
		held.apply(target) { edits -> edits.filterNot { it.path == path && !it.edited } }
	}

	/** Starts the paint fresh over what is held, since a reopen may show text the old paint knew nothing of. */
	private fun startPaint(target: WorkspaceTarget, path: String) {
		val text = editOf(target, path)?.shown ?: return
		painted.reshow(target to path) { plainPaint(text) }
		requestPaint(target, path)
	}

	private fun requestPaint(target: WorkspaceTarget, path: String) {
		paintTimer.debounce(target to path, RAW_PAINT_DEBOUNCE_MS) { sendPaint(target, path) }
	}

	/** Every road that replaces the held text repaints through here, not at its own call site. */
	private fun syncPaint(target: WorkspaceTarget, path: String) {
		val text = editOf(target, path)?.shown ?: return
		val key = target to path
		if (painted.of(key)?.text == text) return
		if (painted.now(key) { adjustPaint(it, text) }) requestPaint(target, path)
	}

	private suspend fun sendPaint(target: WorkspaceTarget, path: String) {
		val ticket = painted.begin(target to path) ?: return
		val text = editOf(target, path)?.shown ?: return
		val gate = host.workspace ?: return
		val answer = try {
			gate.paintText(target, path, text)
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("RawFile", "paint failed: ${e.message}")
			return
		}
		val value = (answer as? WorkspaceAnswer.Read)?.value ?: return
		painted.update(ticket) { current -> landPaint(current, value.textHash, value.spans) }
	}

	/**
	 * The banner's Refresh: the owner chose the file's text, so the draft goes. Answers a notice when the file
	 * could not be read, which leaves the editor and its typing on screen.
	 */
	suspend fun adopt(target: WorkspaceTarget, path: String): String? {
		val tapped = editOf(target, path) ?: return refreshNotice(open(target, path))
		val ticket = shown.begin(target to path)
		val answer = read(target, path)
		val file = (answer as? WorkspaceAnswer.Read)?.value ?: return refreshNotice(rawViewOf(answer))
		// Null when the file can no longer be edited, which lets it go.
		val next = rawEditOf(path, file, tapped.incarnation)
		// Typing or a save since the tap outranks it, and keeps the banner.
		val landed = held.land(target, tapped, Landing.OverUntouched(next))
		syncPaint(target, path)
		if (landed && next == null) redraw(ticket, readOnlyOf(file))
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
				syncPaint(target, edit.path)
				RawSave.Stale(gone = false)
			}
		}
	}

	/** Unfenced: each file's answer lands only on the opening and version its read began from. */
	suspend fun recheck(target: WorkspaceTarget) = sweeping.withLock {
		for (before in held.of(target)) {
			val ticket = shown.begin(target to before.path)
			val fresh = (read(target, before.path) as? WorkspaceAnswer.Read)?.value ?: continue
			val landed = held.land(target, before, Landing.Folded { refreshRaw(it, fresh) })
			syncPaint(target, before.path)
			// Let go, since it can no longer be written, so its screen shows it read-only.
			if (landed && fresh.hash == null && editOf(target, before.path) == null) {
				redraw(ticket, readOnlyOf(fresh))
			}
		}
	}

	suspend fun recheckAll() {
		for (target in held.targets()) recheck(target)
	}

	/** A re-provision takes the previous owner's files with it, on disk as well as in memory. */
	override suspend fun clearInMemory() {
		shown.clear()
		painted.clear()
		for (target in held.targets()) held.apply(target) { emptyList() }
		drafts.clearAll()
	}
}
