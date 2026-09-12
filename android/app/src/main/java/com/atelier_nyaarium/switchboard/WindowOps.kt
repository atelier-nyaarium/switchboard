package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The gateway calls, as a port, so a test drives the whole class without a socket. */
internal interface WorkspaceGateway {
	suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer>

	suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer>

	suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer>

	suspend fun symbolSource(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceSymbolSourceAnswer>

	suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer>
}

internal interface WindowHost {
	val workspace: WorkspaceGateway?
}

/**
 * The open windows and their drafts, which is the only workspace state the phone holds. A tree, an
 * outline and a symbol's detail are re-read rather than cached, as the other per-gateway tabs do.
 *
 * Keyed by SESSION throughout. Two sessions of one gateway hold different workspaces, so a
 * gateway-keyed map would serve one session's span for the other.
 */
internal class WindowOps(
	private val host: WindowHost,
	private val drafts: WindowDraftStore,
	/** Already off the main thread, and no call here names a dispatcher of its own. */
	private val repoScope: CoroutineScope,
) {
	private val reads = GatewayReadFence()

	private val held = MutableStateFlow<Map<WorkspaceTarget, List<Window>>>(emptyMap())

	/** What the window screen collects. Not in `ChatState`, which is persisted and the Router's. */
	val windows: StateFlow<Map<WorkspaceTarget, List<Window>>> = held

	fun windowsOf(target: WorkspaceTarget): List<Window> = held.value[target].orEmpty()

	/** One window at a time, so an open or a close landing mid-recheck is not overwritten. */
	private fun replace(target: WorkspaceTarget, symbolId: String, window: Window) {
		held.update { all ->
			val list = all[target].orEmpty()
			if (list.none { it.descriptor.symbolId == symbolId }) {
				all
			} else {
				all + (target to list.map { if (it.descriptor.symbolId == symbolId) window else it })
			}
		}
	}

	/** Stale answers are dropped rather than drawn, since an older read would put back what moved. */
	private suspend fun <T> fenced(
		target: WorkspaceTarget,
		call: suspend () -> WorkspaceAnswer<T>,
	): WorkspaceAnswer<T> =
		when (val read = reads.read(target.key) { call() }) {
			is GatewayRead.Fresh -> read.value
			GatewayRead.Stale -> WorkspaceAnswer.Unreachable
		}

	suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target) { gate.tree(target, path) }
	}

	suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target) { gate.file(target, path) }
	}

	suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target) { gate.outline(target, path) }
	}

	suspend fun symbol(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceSymbolSourceAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target) { gate.symbolSource(target, symbolId) }
	}

	suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target) { gate.knowledge(target, symbolId) }
	}

	/**
	 * A long press, which accumulates. A draft held for the symbol is restored, so a window reopened
	 * after the process died comes back with the owner's typing rather than the file's text.
	 */
	suspend fun openWindow(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<Window> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return when (val answer = fenced(target) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val opened = Window(
					descriptor = descriptorOf(answer.value),
					original = answer.value.text,
					draft = drafts.load(target, symbolId),
				)
				held.update { all -> all + (target to withWindow(all[target].orEmpty(), opened)) }
				WorkspaceAnswer.Read(opened)
			}
			is WorkspaceAnswer.Refused -> answer
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/** The one road that discards a draft by closing, so closing is how the owner abandons one. */
	fun closeWindow(target: WorkspaceTarget, symbolId: String) {
		held.update { all -> all + (target to withoutWindow(all[target].orEmpty(), symbolId)) }
		repoScope.launch { drafts.clear(target, symbolId) }
	}

	/** Memory first so the field stays responsive; the draft reaches disk off the main thread. */
	fun type(target: WorkspaceTarget, symbolId: String, text: String) {
		val window = windowsOf(target).firstOrNull { it.descriptor.symbolId == symbolId } ?: return
		replace(target, symbolId, window.copy(draft = text))
		repoScope.launch { drafts.save(target, symbolId, text) }
	}

	/**
	 * What the stale banner's Refresh does. The owner has chosen the file's text over their own, so the
	 * draft goes; `recheck` never does this, which is why the banner exists at all.
	 */
	suspend fun adopt(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<Window> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return when (val fresh = fenced(target) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val next = Window(descriptor = descriptorOf(fresh.value), original = fresh.value.text)
				replace(target, symbolId, next)
				repoScope.launch { drafts.clear(target, symbolId) }
				WorkspaceAnswer.Read(next)
			}
			is WorkspaceAnswer.Refused -> fresh
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/**
	 * The foreground re-check, unfenced because it is a sweep over windows already held rather than a
	 * read of something the owner just asked for. `refreshWith` decides each one.
	 */
	suspend fun recheck(target: WorkspaceTarget) {
		val gate = host.workspace ?: return
		for (window in windowsOf(target)) {
			val fresh = gate.symbolSource(target, window.descriptor.symbolId)
			if (fresh !is WorkspaceAnswer.Read) continue
			when (val outcome = refreshWith(window, fresh.value)) {
				RefreshOutcome.Unchanged -> {}
				is RefreshOutcome.Adopted -> replace(target, window.descriptor.symbolId, outcome.window)
				is RefreshOutcome.Conflicts -> replace(target, window.descriptor.symbolId, outcome.window)
			}
		}
	}

	/** Every session with a window open, which is what coming back to the app re-checks. */
	suspend fun recheckAll() {
		for (target in held.value.keys) recheck(target)
	}

	/** What Agent Apply sends, for every span the owner actually changed. */
	fun agentRequests(target: WorkspaceTarget): List<AgentRequest> =
		editedWindows(windowsOf(target)).mapNotNull { agentRequestOf(it) }
}
