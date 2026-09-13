package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val UNREACHABLE = "This session could not be reached"

/**
 * Each folder's tree and file operation, published so the screen only renders. A destructive op sends only
 * what was confirmed; an unanswered one is read back, never retried.
 */
internal class WorkspaceFileOps(
	private val host: WorkspaceHost,
	private val typingAt: suspend (WorkspaceTarget, String) -> Boolean,
) : ClearsOnReprovision {
	/** One at a time, so a second op cannot race the first's answer. */
	private val mutating = Mutex()

	private val drawn = MutableStateFlow<Map<Pair<WorkspaceTarget, String>, FolderView>>(emptyMap())

	/** Each folder's live opening. A leave or a re-provision ends it, and work begun in it lands nothing after. */
	private val openings = ConcurrentHashMap<Pair<WorkspaceTarget, String>, Any>()

	/** The newest tree read of each folder, so an older one lands nothing. */
	private val reading = ConcurrentHashMap<Pair<WorkspaceTarget, String>, Any>()

	/** What each shown folder draws. Absent: no screen has asked, or it left. */
	val views: StateFlow<Map<Pair<WorkspaceTarget, String>, FolderView>> = drawn

	fun viewOf(target: WorkspaceTarget, path: String): FolderView? = drawn.value[target to path]

	/** Where work began: the folder's opening and the generation, both of which it must still be in to land. */
	private data class Began(val key: Pair<WorkspaceTarget, String>, val opening: Any, val generation: Long)

	private fun began(key: Pair<WorkspaceTarget, String>): Began? =
		openings[key]?.let { Began(key, it, host.generation.capture()) }

	private fun current(began: Began) = openings[began.key] === began.opening && host.generation.isCurrent(began.generation)

	private fun redraw(began: Began, change: (FolderView) -> FolderView) {
		drawn.update { all ->
			val view = all[began.key]
			if (view == null || !current(began)) all else all + (began.key to change(view))
		}
	}

	/** Takes the folder for one op, or nothing while one is running or `ready` says no. */
	private fun claim(key: Pair<WorkspaceTarget, String>, ready: (FolderView) -> Boolean): Pair<Began, FolderView>? {
		val began = began(key) ?: return null
		var claimed: FolderView? = null
		drawn.update { all ->
			val view = all[key]
			claimed = view?.takeIf { !it.busy && ready(it) && current(began) }
			claimed?.let { all + (key to it.copy(busy = true, asking = null, confirming = null, outcome = null)) } ?: all
		}
		return claimed?.let { began to it }
	}

	/** Runs a claimed op, and lets the folder go if the op's caller is cancelled. */
	private suspend fun claimed(began: Began, work: suspend () -> Unit) {
		try {
			work()
		} catch (e: CancellationException) {
			redraw(began) { it.copy(busy = false) }
			throw e
		}
	}

	suspend fun open(target: WorkspaceTarget, path: String) {
		val key = target to path
		openings.putIfAbsent(key, Any())
		drawn.update { all -> if (key in all) all else all + (key to FolderView()) }
		reload(key)
	}

	fun leave(target: WorkspaceTarget, path: String) {
		openings.remove(target to path)
		reading.remove(target to path)
		drawn.update { it - (target to path) }
	}

	private suspend fun reload(key: Pair<WorkspaceTarget, String>) {
		val began = began(key) ?: return
		val mine = Any()
		reading[key] = mine
		try {
			val gate = host.workspace
			val listing = if (gate == null) WorkspaceAnswer.Unreachable else guarded { gate.tree(key.first, key.second) }
			if (reading[key] === mine) redraw(began) { it.copy(listing = listing) }
		} finally {
			reading.remove(key, mine)
		}
	}

	/** Opens the path dialog. */
	fun ask(target: WorkspaceTarget, path: String, ask: PathAsk) {
		began(target to path)?.let { redraw(it) { view -> if (view.busy) view else view.copy(asking = ask, outcome = null) } }
	}

	fun dismiss(target: WorkspaceTarget, path: String) {
		began(target to path)?.let { redraw(it) { view -> view.copy(asking = null, confirming = null) } }
	}

	/** The created file was opened. */
	fun rawOpened(target: WorkspaceTarget, path: String) {
		began(target to path)?.let { redraw(it) { view -> view.copy(openRaw = null) } }
	}

	/** The path dialog's answer. A second answer to the same dialog does nothing. */
	suspend fun choose(target: WorkspaceTarget, path: String, action: FileAction) {
		val (began, _) = claim(target to path) { it.asking != null } ?: return
		claimed(began) {
			when (action) {
				is CreateFile -> finish(began, action) { create(began, action.path) }
				is ArmedAction -> armFor(began, action)
			}
		}
	}

	/** Arms without the path dialog. */
	suspend fun begin(target: WorkspaceTarget, path: String, action: ArmedAction) {
		val (began, _) = claim(target to path) { true } ?: return
		claimed(began) { armFor(began, action) }
	}

	/** Sends the confirmation shown, once. */
	suspend fun confirm(target: WorkspaceTarget, path: String) {
		val (began, view) = claim(target to path) { it.confirming != null } ?: return
		val op = view.confirming ?: return
		claimed(began) { finish(began, op.action) { perform(began, op) } }
	}

	override suspend fun clearInMemory() {
		openings.clear()
		reading.clear()
		drawn.value = emptyMap()
	}

	private suspend fun armFor(began: Began, action: ArmedAction) {
		val arming = arm(began.key.first, action)
		redraw(began) {
			when (arming) {
				is Arming.Armed -> it.copy(busy = false, confirming = arming.op)
				is Arming.Refused -> it.copy(busy = false, outcome = FolderOutcome.NotArmed(arming.reason))
			}
		}
	}

	private suspend fun finish(began: Began, action: FileAction, work: suspend () -> FileOpResult) {
		val result = work()
		redraw(began) {
			it.copy(busy = false, outcome = FolderOutcome.Finished(action, result), openRaw = rawToOpen(action, result))
		}
		if (treeMoved(result) && current(began)) reload(began.key)
	}

	private suspend fun arm(target: WorkspaceTarget, action: ArmedAction): Arming {
		val gate = host.workspace ?: return Arming.Refused(UNREACHABLE)
		val source = when (val read = state(gate, target, action.path)) {
			is WorkspaceAnswer.Read -> fileFactOf(read.value)
			is WorkspaceAnswer.Refused -> return Arming.Refused(read.reason)
			WorkspaceAnswer.Unreachable -> return Arming.Refused(UNREACHABLE)
		}
		val to = when (action) {
			is ArmedAction.Delete -> null
			is ArmedAction.Move -> action.to
			is ArmedAction.Copy -> action.to
		}
		val destination = to?.let {
			when (val read = state(gate, target, it)) {
				is WorkspaceAnswer.Read -> fileFactOf(read.value)
				is WorkspaceAnswer.Refused -> return Arming.Refused(read.reason)
				WorkspaceAnswer.Unreachable -> return Arming.Refused(UNREACHABLE)
			}
		}
		return armedOf(action, source, destination, typingAt(target, action.path))
	}

	/** The gateway to send through, only while the op's folder and generation still stand. */
	private fun gateFor(began: Began): WorkspaceGateway? = host.workspace?.takeIf { current(began) }

	private suspend fun perform(began: Began, op: ArmedFileOp): FileOpResult = mutating.withLock {
		val target = began.key.first
		val gate = gateFor(began) ?: return@withLock FileOpResult.Refused(UNREACHABLE)
		when (val answer = mutate(gate, target, op.mutation)) {
			is WorkspaceAnswer.Read -> answeredOf(answer.value) ?: settle(gate, target, op, answer.value.reason)
			is WorkspaceAnswer.Refused -> FileOpResult.Refused(answer.reason)
			WorkspaceAnswer.Unreachable -> settle(gate, target, op, null)
		}
	}

	/** Empty, and only where nothing is. */
	private suspend fun create(began: Began, path: String): FileOpResult = mutating.withLock {
		val target = began.key.first
		val gate = gateFor(began) ?: return@withLock FileOpResult.Refused(UNREACHABLE)
		val readBack: suspend (String?) -> FileOpResult = { reason ->
			createdOf((state(gate, target, path) as? WorkspaceAnswer.Read)?.value, reason)
		}
		when (val answer = mutate(gate, target, WorkspaceFileMutation.Create(path = path, text = ""))) {
			is WorkspaceAnswer.Read -> answeredOf(answer.value) ?: readBack(answer.value.reason)
			is WorkspaceAnswer.Refused -> FileOpResult.Refused(answer.reason)
			WorkspaceAnswer.Unreachable -> readBack(null)
		}
	}

	private suspend fun settle(gate: WorkspaceGateway, target: WorkspaceTarget, op: ArmedFileOp, reason: String?): FileOpResult {
		val fact = { answer: WorkspaceAnswer<WorkspaceFileStateAnswer> ->
			(answer as? WorkspaceAnswer.Read)?.value?.let(::fileFactOf)
		}
		val source = fact(state(gate, target, op.action.path))
		val destination = when (val action = op.action) {
			is ArmedAction.Delete -> null
			is ArmedAction.Move -> fact(state(gate, target, action.to))
			is ArmedAction.Copy -> fact(state(gate, target, action.to))
		}
		return settledOf(op, source, destination, reason)
	}

	private suspend fun state(gate: WorkspaceGateway, target: WorkspaceTarget, path: String) =
		guarded { gate.fileState(target, path) }

	private suspend fun mutate(gate: WorkspaceGateway, target: WorkspaceTarget, mutation: WorkspaceFileMutation) =
		guarded<WorkspaceFileMutationAnswer> { gate.mutateFile(target, mutation) }

	/** A throw is no answer, which a mutation settles by reading back. */
	private suspend fun <T> guarded(call: suspend () -> WorkspaceAnswer<T>): WorkspaceAnswer<T> =
		try {
			call()
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("FileOps", "call failed: ${e.message}")
			WorkspaceAnswer.Unreachable
		}
}
