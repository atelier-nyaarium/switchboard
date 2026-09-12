package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
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

	/** An apply is an ordinary message to the session, not a write plane. */
	suspend fun send(address: String, text: String): Boolean
}

/** What Agent Apply did, never a bare Boolean: nothing to send is not a failure to send. */
internal sealed interface Applied {
	data class Sent(val spans: Int) : Applied

	data object NothingEdited : Applied

	data object Failed : Applied
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
) : ClearsOnReprovision {
	private val reads = GatewayReadFence()

	private val held = MutableStateFlow<Map<WorkspaceTarget, List<Window>>>(emptyMap())

	/** The file around each open window, so leaving the screen and coming back re-reads nothing. */
	private val context = java.util.concurrent.ConcurrentHashMap<Pair<WorkspaceTarget, String>, List<String>>()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	/**
	 * Held across the write and the enqueue that follows it, so the files are asked for in the order the
	 * values landed. A plain monitor rather than a `Mutex`, since the screen calls `apply` off a keystroke
	 * and cannot suspend; nothing inside it reaches the disk or the network.
	 */
	private val applying = Any()

	/** What the window screen collects. Not in `ChatState`, which is persisted and the Router's. */
	val windows: StateFlow<Map<WorkspaceTarget, List<Window>>> = held

	fun windowsOf(target: WorkspaceTarget): List<Window> = held.value[target].orEmpty()

	/** Minted per open, so two openings of one symbol are two windows. */
	private val incarnations = java.util.concurrent.atomic.AtomicLong(0)

	/**
	 * Moves whenever the SET of windows changes. Work that began before a close, or before a
	 * re-provision, reads this at the start and lands nothing if it has moved since.
	 */
	private val epoch = java.util.concurrent.atomic.AtomicLong(0)

	/**
	 * THE one road into held state: every change is a function of what is held NOW, so a decision made
	 * from a value read before a network wait cannot be written back. A caller that captured a window,
	 * awaited the gateway, and then wrote what it decided is the shape this exists to make unwritable.
	 *
	 * The transform sees the session's windows and returns them; returning the same list writes nothing.
	 * It runs inside the atomic update, so a check it makes is not racing the write it guards.
	 */
	private fun apply(target: WorkspaceTarget, transform: (List<Window>) -> List<Window>) {
		synchronized(applying) {
			var before = emptyList<Window>()
			var after = emptyList<Window>()
			held.update { all ->
				before = all[target].orEmpty()
				after = transform(before)
				if (after == before) all else all + (target to after)
			}
			// Assigned inside a compare-and-set that may retry, so only the winning attempt is persisted.
			persistDrafts(target, before, after)
		}
	}

	/**
	 * The disk follows the value. A caller changes a window and never says what the file should do, so
	 * the pair cannot drift: a draft that appeared is written, one that went is deleted, and a window
	 * that left takes its file with it.
	 *
	 * Keyed by incarnation, the one notion of window identity `applyTo` and the epoch guard also read.
	 */
	private fun persistDrafts(target: WorkspaceTarget, before: List<Window>, after: List<Window>) {
		// Departures first: a file is named by its symbol, so a window leaving and another of the same
		// symbol arriving name one file, and the leaver must not delete what the arrival just wrote.
		val kept = after.mapTo(HashSet()) { it.incarnation }
		for (window in before) {
			if (window.incarnation in kept) continue
			drafts.clear(target, window.descriptor.symbolId)
		}
		val was = before.associateBy { it.incarnation }
		for (window in after) {
			val draft = window.draft
			if (was[window.incarnation]?.draft == draft) continue
			val symbolId = window.descriptor.symbolId
			if (draft == null) drafts.clear(target, symbolId) else drafts.save(target, symbolId, draft)
		}
	}

	/**
	 * One window, found by the incarnation the caller read. A window closed and reopened during a wait
	 * is a DIFFERENT window, so an answer about the old one lands nowhere.
	 */
	private fun applyTo(target: WorkspaceTarget, incarnation: Long, transform: (Window) -> Window) {
		apply(target) { windows ->
			if (windows.none { it.incarnation == incarnation }) {
				windows
			} else {
				windows.map { if (it.incarnation == incarnation) transform(it) else it }
			}
		}
	}

	private fun windowFor(target: WorkspaceTarget, symbolId: String): Window? =
		windowsOf(target).firstOrNull { it.descriptor.symbolId == symbolId }

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
		val began = epoch.get()
		return when (val answer = fenced(target, ReadSlot.Span(symbolId)) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val draft = drafts.load(target, symbolId)
				val opened = Window(
					descriptor = descriptorOf(answer.value),
					original = answer.value.text,
					draft = draft,
					incarnation = incarnations.incrementAndGet(),
				)
				// A close or a re-provision while this was in flight means the owner does not want it.
				apply(target) { if (epoch.get() == began) withWindow(it, opened) else it }
				WorkspaceAnswer.Read(opened)
			}
			is WorkspaceAnswer.Refused -> answer
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/** The one road that discards a draft by closing, so closing is how the owner abandons one. */
	fun closeWindow(target: WorkspaceTarget, symbolId: String) {
		val module = windowFor(target, symbolId)?.descriptor?.module
		epoch.incrementAndGet()
		apply(target) { withoutWindow(it, symbolId) }
		// A whole file is held for context, so it goes as soon as no window of it is open.
		if (module != null && windowsOf(target).none { it.descriptor.module == module }) {
			context.remove(target to module)
		}
	}

	/** Memory only; the disk follows from the value, off the caller's thread. */
	fun type(target: WorkspaceTarget, symbolId: String, text: String) {
		val window = windowFor(target, symbolId) ?: return
		applyTo(target, window.incarnation) { it.copy(draft = text) }
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
		val lines = answer.value.text.split("\n")
		// Kept only while a window still needs it, or a close during the read leaves bytes nothing drops.
		if (windowsOf(target).any { it.descriptor.module == module }) context[target to module] = lines
		return lines
	}

	/** The banner's Refresh: the owner chose the file's text, so the draft goes. `recheck` never does. */
	suspend fun adopt(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<Window> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		val incarnation = windowFor(target, symbolId)?.incarnation ?: return WorkspaceAnswer.Unreachable
		return when (val fresh = fenced(target, ReadSlot.Span(symbolId)) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val next = Window(
					descriptor = descriptorOf(fresh.value),
					original = fresh.value.text,
					incarnation = incarnation,
				)
				applyTo(target, incarnation) { next }
				WorkspaceAnswer.Read(next)
			}
			is WorkspaceAnswer.Refused -> fresh
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/**
	 * Unfenced: a sweep over windows already held, not a read the owner just asked for. The fence would
	 * be wrong here, since it hands the key to whoever claimed last, so a sweep would discard the
	 * Refresh the owner just tapped and answer them nothing.
	 *
	 * The span the sweep read is what it may judge, so each window carries the hash it was holding when
	 * the read began. An answer describing a version the window has already moved past is older news
	 * than what it is showing, and `refreshWith` compares hashes for equality alone: it would take that
	 * older text as the file catching up and quietly put it back.
	 */
	suspend fun recheck(target: WorkspaceTarget) = sweeping.withLock {
		val gate = host.workspace ?: return@withLock
		for (held in windowsOf(target).map { Triple(it.descriptor.symbolId, it.incarnation, it.descriptor.spanHash) }) {
			val (symbolId, incarnation, began) = held
			val fresh = gate.symbolSource(target, symbolId)
			if (fresh !is WorkspaceAnswer.Read) continue
			// Judged against the window as it stands, and only if it is still the one that was read.
			applyTo(target, incarnation) { current ->
				if (current.descriptor.spanHash != began) {
					current
				} else {
					when (val outcome = refreshWith(current, fresh.value)) {
						RefreshOutcome.Unchanged -> current
						is RefreshOutcome.Adopted -> outcome.window
						is RefreshOutcome.Conflicts -> outcome.window
					}
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

	/**
	 * Asks the session to make the edits. The drafts stay: the agent may refuse a span whose file
	 * moved, and the owner's typing is the only copy of what they wanted. The foreground re-check
	 * raises the stale banner once the file actually changes, and Refresh is how they let it go.
	 */
	suspend fun agentApply(target: WorkspaceTarget): Applied {
		val requests = agentRequests(target)
		val text = applyMessage(requests) ?: return Applied.NothingEdited
		// A throwing send would otherwise take the screen's coroutine with it and say nothing at all.
		val sent = try {
			host.send(target.address, text)
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("Window", "apply failed: ${e.message}")
			false
		}
		return if (sent) Applied.Sent(requests.size) else Applied.Failed
	}

	/** A re-provision takes the previous owner's code with it, on disk as well as in memory. */
	override suspend fun clearInMemory() {
		// Before the clear, so a read already in flight cannot add the previous owner's window after it.
		epoch.incrementAndGet()
		for (target in held.value.keys) apply(target) { emptyList() }
		context.clear()
		drafts.clearAll()
	}
}
