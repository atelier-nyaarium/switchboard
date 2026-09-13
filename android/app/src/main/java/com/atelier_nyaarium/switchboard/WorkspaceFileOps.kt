package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val UNREACHABLE = "This session could not be reached"

/** Where an op began: the folder's showing and the generation it must still be in to land. */
private typealias Began = PublishedViews.Showing<Pair<WorkspaceTarget, String>>

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

	/** A folder's showing ends at leave: an op begun in it lands nothing on a later one. */
	private val shown = PublishedViews<Pair<WorkspaceTarget, String>, FolderView>(host.generation)

	/** The newest tree read of each folder, so an older one lands nothing. */
	private val reading = ConcurrentHashMap<Pair<WorkspaceTarget, String>, Any>()

	/** What each shown folder draws. Absent: no screen has asked, or it left. */
	val views: StateFlow<Map<Pair<WorkspaceTarget, String>, FolderView>> = shown.all

	fun viewOf(target: WorkspaceTarget, path: String): FolderView? = shown.of(target to path)

	private fun redraw(began: Began, change: (FolderView) -> FolderView) {
		shown.update(began, change)
	}

	private fun current(began: Began) = shown.isCurrent(began)

	/** Takes the folder for one op, or nothing while one is running or `ready` says no. */
	private fun claim(key: Pair<WorkspaceTarget, String>, ready: (FolderView) -> Boolean): Pair<Began, FolderView>? {
		val began = shown.current(key) ?: return null
		val claimed = shown.claim(
			began,
			take = { !it.busy && ready(it) },
			taken = { it.copy(busy = true, asking = null, confirming = null, outcome = null) },
		)
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
		shown.show(target to path) { FolderView() }
		reload(target to path)
	}

	/** Shows the folder while the caller runs, reopening it after a re-provision. */
	suspend fun keepOpen(target: WorkspaceTarget, path: String) {
		try {
			coroutineScope {
				views.map { (target to path) !in it }.distinctUntilChanged().collect { absent ->
					if (absent) launch { open(target, path) }
				}
			}
		} finally {
			leave(target, path)
		}
	}

	fun leave(target: WorkspaceTarget, path: String) {
		shown.leave(target to path)
		reading.remove(target to path)
	}

	private suspend fun reload(key: Pair<WorkspaceTarget, String>) {
		val began = shown.current(key) ?: return
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
		shown.current(target to path)?.let { redraw(it) { view -> if (view.busy) view else view.copy(asking = ask, outcome = null) } }
	}

	fun dismiss(target: WorkspaceTarget, path: String) {
		shown.current(target to path)?.let { redraw(it) { view -> view.copy(asking = null, confirming = null) } }
	}

	/** The created file was opened. */
	fun rawOpened(target: WorkspaceTarget, path: String) {
		shown.current(target to path)?.let { redraw(it) { view -> view.copy(openRaw = null) } }
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
		shown.clear()
		reading.clear()
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
