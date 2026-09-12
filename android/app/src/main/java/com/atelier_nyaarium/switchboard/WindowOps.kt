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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A port, so a test drives the whole class without a socket. */
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
 * The open windows and their drafts, the only workspace state the phone holds. Everything else is
 * re-read, as the other per-gateway tabs do.
 *
 * Keyed by SESSION: two sessions of one gateway hold different workspaces.
 */
internal class WindowOps(
	private val host: WindowHost,
	private val drafts: WindowDraftStore,
	/** Already off the main thread, and no call here names a dispatcher of its own. */
	private val repoScope: CoroutineScope,
) : ClearsOnReprovision {
	private val reads = GatewayReadFence()

	private val held = MutableStateFlow<Map<WorkspaceTarget, List<Window>>>(emptyMap())

	/** The file around each open window, so leaving the screen and coming back re-reads nothing. */
	private val context = java.util.concurrent.ConcurrentHashMap<Pair<WorkspaceTarget, String>, List<String>>()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	/** Draft writes in the order they were asked for, and never interleaved on one temp file. */
	private val writing = Mutex()

	/** What the window screen collects. Not in `ChatState`, which is persisted and the Router's. */
	val windows: StateFlow<Map<WorkspaceTarget, List<Window>>> = held

	fun windowsOf(target: WorkspaceTarget): List<Window> = held.value[target].orEmpty()

	/**
	 * THE one road into held state: every change is a function of what is held NOW, so a decision made
	 * from a value read before a network wait cannot be written back. A caller that captured a window,
	 * awaited the gateway, and then wrote what it decided is the shape this exists to make unwritable.
	 *
	 * The transform sees the session's windows and returns them; returning the same list writes nothing.
	 */
	private fun apply(target: WorkspaceTarget, transform: (List<Window>) -> List<Window>) {
		held.update { all ->
			val before = all[target].orEmpty()
			val after = transform(before)
			if (after == before) all else all + (target to after)
		}
	}

	/** One window, found by id as it stands. Absent means it was closed, and nothing is written. */
	private fun applyTo(target: WorkspaceTarget, symbolId: String, transform: (Window) -> Window) {
		apply(target) { windows ->
			if (windows.none { it.descriptor.symbolId == symbolId }) {
				windows
			} else {
				windows.map { if (it.descriptor.symbolId == symbolId) transform(it) else it }
			}
		}
	}

	/**
	 * Stale answers are dropped rather than drawn, since an older read would put back what moved.
	 *
	 * The key names the SLOT, not just the session: a symbol's source and its knowledge are two
	 * things on one screen, and one key for both makes each read cancel the other.
	 */
	private suspend fun <T> fenced(
		target: WorkspaceTarget,
		slot: ReadSlot,
		call: suspend () -> WorkspaceAnswer<T>,
	): WorkspaceAnswer<T> =
		when (val read = reads.read(separated(target.key, slot.key)) { call() }) {
			is GatewayRead.Fresh -> read.value
			GatewayRead.Stale -> WorkspaceAnswer.Unreachable
		}

	suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target, ReadSlot.Tree) { gate.tree(target, path) }
	}

	suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target, ReadSlot.File) { gate.file(target, path) }
	}

	suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target, ReadSlot.Outline) { gate.outline(target, path) }
	}

	suspend fun symbol(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceSymbolSourceAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target, ReadSlot.Source) { gate.symbolSource(target, symbolId) }
	}

	suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return fenced(target, ReadSlot.Knowledge) { gate.knowledge(target, symbolId) }
	}

	/** Accumulates, and restores any held draft, so a reopen after the process died keeps the typing. */
	suspend fun openWindow(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<Window> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return when (val answer = fenced(target, ReadSlot.Span(symbolId)) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val opened = Window(
					descriptor = descriptorOf(answer.value),
					original = answer.value.text,
					draft = drafts.load(target, symbolId),
				)
				apply(target) { withWindow(it, opened) }
				WorkspaceAnswer.Read(opened)
			}
			is WorkspaceAnswer.Refused -> answer
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/** The one road that discards a draft by closing, so closing is how the owner abandons one. */
	fun closeWindow(target: WorkspaceTarget, symbolId: String) {
		val module = windowsOf(target).firstOrNull { it.descriptor.symbolId == symbolId }?.descriptor?.module
		apply(target) { withoutWindow(it, symbolId) }
		// A whole file is held for context, so it goes as soon as no window of it is open.
		if (module != null && windowsOf(target).none { it.descriptor.module == module }) {
			context.remove(target to module)
		}
		repoScope.launch { writing.withLock { drafts.clear(target, symbolId) } }
	}

	/** Memory first so the field stays responsive; the draft reaches disk off the main thread. */
	fun type(target: WorkspaceTarget, symbolId: String, text: String) {
		applyTo(target, symbolId) { it.copy(draft = text) }
		repoScope.launch {
			// Under the lock, so a clear cannot land between the check and the write.
			writing.withLock { if (holdsDraft(windowsOf(target), symbolId, text)) drafts.save(target, symbolId, text) }
		}
	}

	/**
	 * The file a window sits in, for the lines either side of it. Unfenced, since a cache keyed by
	 * module has nothing an older answer could overwrite, and a fenced read dropped by an unrelated
	 * tap would leave that module without context until the screen was rebuilt.
	 */
	suspend fun contextFor(target: WorkspaceTarget, module: String): List<String>? {
		context[target to module]?.let { return it }
		val gate = host.workspace ?: return null
		val answer = gate.file(target, module)
		if (answer !is WorkspaceAnswer.Read) return null
		return answer.value.text.split("\n").also { context[target to module] = it }
	}

	/** The banner's Refresh: the owner chose the file's text, so the draft goes. `recheck` never does. */
	suspend fun adopt(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<Window> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return when (val fresh = fenced(target, ReadSlot.Span(symbolId)) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val next = Window(descriptor = descriptorOf(fresh.value), original = fresh.value.text)
				applyTo(target, symbolId) { next }
				repoScope.launch { writing.withLock { drafts.clear(target, symbolId) } }
				WorkspaceAnswer.Read(next)
			}
			is WorkspaceAnswer.Refused -> fresh
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/** Unfenced: a sweep over windows already held, not a read the owner just asked for. */
	suspend fun recheck(target: WorkspaceTarget) = sweeping.withLock {
		val gate = host.workspace ?: return@withLock
		for (symbolId in windowsOf(target).map { it.descriptor.symbolId }) {
			val fresh = gate.symbolSource(target, symbolId)
			if (fresh !is WorkspaceAnswer.Read) continue
			// Judged against the window as it stands, which is the only thing `applyTo` will hand it.
			applyTo(target, symbolId) { current ->
				when (val outcome = refreshWith(current, fresh.value)) {
					RefreshOutcome.Unchanged -> current
					is RefreshOutcome.Adopted -> outcome.window
					is RefreshOutcome.Conflicts -> outcome.window
				}
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

	/** A re-provision takes the previous owner's code with it, on disk as well as in memory. */
	override suspend fun clearInMemory() {
		held.value = emptyMap()
		context.clear()
		writing.withLock { drafts.clearAll() }
	}
}
