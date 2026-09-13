package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val UNREACHABLE = "This session could not be reached"

/** A destructive op sends only what the owner confirmed. An unanswered one is read back, never retried. */
internal class WorkspaceFileOps(
	private val host: WorkspaceHost,
	private val typingAt: suspend (WorkspaceTarget, String) -> Boolean,
) : ClearsOnReprovision {
	/** One at a time, so a second tap cannot race the first's answer. */
	private val mutating = Mutex()

	/** The one confirmation per session still sendable. A send, a newer arming or a re-provision spends it. */
	private val confirmable = ConcurrentHashMap<WorkspaceTarget, ArmedFileOp>()

	/** Moves on a re-provision, so an arming in flight issues nothing. */
	private val epoch = AtomicLong(0)

	suspend fun arm(target: WorkspaceTarget, action: ArmedAction): Arming {
		val began = epoch.get()
		val arming = facts(target, action)
		if (arming !is Arming.Armed) return arming
		synchronized(confirmable) {
			if (epoch.get() != began) return Arming.Refused(UNREACHABLE)
			confirmable[target] = arming.op
		}
		return arming
	}

	private suspend fun facts(target: WorkspaceTarget, action: ArmedAction): Arming {
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

	/** Refused for a confirmation already spent, so a second tap sends nothing. */
	suspend fun perform(target: WorkspaceTarget, op: ArmedFileOp): FileOpResult {
		if (!confirmable.remove(target, op)) return FileOpResult.Refused("This confirmation was already used")
		return mutating.withLock { sent(target, op) }
	}

	override suspend fun clearInMemory() {
		synchronized(confirmable) {
			epoch.incrementAndGet()
			confirmable.clear()
		}
	}

	private suspend fun sent(target: WorkspaceTarget, op: ArmedFileOp): FileOpResult {
		val gate = host.workspace ?: return FileOpResult.Refused(UNREACHABLE)
		return when (val answer = mutate(gate, target, op.mutation)) {
			is WorkspaceAnswer.Read -> answeredOf(answer.value) ?: settle(gate, target, op, answer.value.reason)
			is WorkspaceAnswer.Refused -> FileOpResult.Refused(answer.reason)
			WorkspaceAnswer.Unreachable -> settle(gate, target, op, null)
		}
	}

	/** Empty, and only where nothing is. */
	suspend fun create(target: WorkspaceTarget, path: String): FileOpResult = mutating.withLock {
		val gate = host.workspace ?: return@withLock FileOpResult.Refused(UNREACHABLE)
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
