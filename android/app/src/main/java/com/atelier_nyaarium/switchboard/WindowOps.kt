package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
	private val host: WorkspaceHost,
	private val drafts: WorkspaceDraftStore,
) : ClearsOnReprovision {
	private val reads = GatewayReadFence()

	private val held = HeldEdits<Window>(drafts)

	/** The file around each open window, so leaving the screen and coming back re-reads nothing. */
	private val context = java.util.concurrent.ConcurrentHashMap<Pair<WorkspaceTarget, String>, List<String>>()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	/** One save at a time, or a second tap sends a span the first is still writing. */
	private val saving = Mutex()

	/** What the window screen collects. Not in `ChatState`, which is persisted and the Router's. */
	val windows: StateFlow<Map<WorkspaceTarget, List<Window>>> = held.all

	fun windowsOf(target: WorkspaceTarget): List<Window> = held.of(target)

	/** Minted per open, so two openings of one symbol are two windows. */
	private val incarnations = java.util.concurrent.atomic.AtomicLong(0)

	/**
	 * Moves whenever a window leaves the set. Work that began before a close reads this at the start and lands
	 * nothing if it has moved since; `host.generation` does the same for a re-provision.
	 */
	private val epoch = java.util.concurrent.atomic.AtomicLong(0)

	private fun settled(target: WorkspaceTarget): (List<Window>, List<Window>) -> Unit = { before, after ->
		// A window leaving the set is what the epoch guards.
		if (after.size < before.size) epoch.incrementAndGet()
		// A whole file is held for context, so it goes as soon as no window of it is open.
		val open = after.mapTo(HashSet()) { it.descriptor.module }
		for (module in before.map { it.descriptor.module }.distinct()) {
			if (module !in open) context.remove(target to module)
		}
	}

	private fun apply(target: WorkspaceTarget, transform: (List<Window>) -> List<Window>) =
		held.apply(target, settled(target), transform)

	private fun land(target: WorkspaceTarget, before: Window, landing: Landing<Window>): Boolean =
		held.land(target, before, landing, settled(target))

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
		val generation = host.generation.capture()
		return when (val answer = fenced(target, ReadSlot.Span(symbolId)) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val opened = restored(
					Window(
						descriptor = descriptorOf(answer.value),
						original = answer.value.text,
						incarnation = incarnations.incrementAndGet(),
					),
					drafts.load(target, DraftKey.Span(symbolId)),
				)
				// A close or a re-provision while this was in flight means the owner does not want it.
				apply(target) {
					if (epoch.get() == began && host.generation.isCurrent(generation)) withWindow(it, opened) else it
				}
				WorkspaceAnswer.Read(opened)
			}
			is WorkspaceAnswer.Refused -> answer
			WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
		}
	}

	/** The one road that discards a draft by closing, so closing is how the owner abandons one. */
	fun closeWindow(target: WorkspaceTarget, symbolId: String) {
		epoch.incrementAndGet()
		apply(target) { withoutWindow(it, symbolId) }
	}

	/** Memory only; the disk follows from the value, off the caller's thread. A caret move is not typing. */
	fun type(target: WorkspaceTarget, symbolId: String, text: String) {
		val window = windowFor(target, symbolId) ?: return
		apply(target) { windows ->
			windows.map { if (it.incarnation == window.incarnation && it.shown != text) it.copy(draft = text) else it }
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
		val generation = host.generation.capture()
		val answer = gate.file(target, module)
		if (answer !is WorkspaceAnswer.Read || !host.generation.isCurrent(generation)) return null
		val lines = answer.value.text.split("\n")
		// Kept only while a window still needs it, or a close during the read leaves bytes nothing drops.
		if (windowsOf(target).any { it.descriptor.module == module }) context[target to module] = lines
		return lines
	}

	/** The banner's Refresh: the owner chose the file's text, so the draft goes. `recheck` never does. */
	suspend fun adopt(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<Window> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		val tapped = windowFor(target, symbolId) ?: return WorkspaceAnswer.Unreachable
		return when (val fresh = fenced(target, ReadSlot.Span(symbolId)) { gate.symbolSource(target, symbolId) }) {
			is WorkspaceAnswer.Read -> {
				val next = Window(
					descriptor = descriptorOf(fresh.value),
					original = fresh.value.text,
					incarnation = tapped.incarnation,
				)
				// Typing or a save since the tap outranks it, and keeps the banner.
				land(target, tapped, Landing.OverUntouched(next))
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
		for (before in windowsOf(target)) {
			val fresh = gate.symbolSource(target, before.descriptor.symbolId)
			if (fresh !is WorkspaceAnswer.Read) continue
			land(target, before, Landing.Folded { current ->
				when (val outcome = refreshWith(current, fresh.value)) {
					RefreshOutcome.Unchanged -> current
					is RefreshOutcome.Adopted -> outcome.window
					is RefreshOutcome.Conflicts -> outcome.window
				}
			})
		}
	}

	/**
	 * Each edited span, only while it still hashes to what the owner was shown. A save with no answer
	 * may have landed, so its windows are re-read rather than assumed.
	 */
	suspend fun save(target: WorkspaceTarget): SaveReport = saving.withLock {
		val gate = host.workspace ?: return@withLock SaveReport(unknown = editedWindows(windowsOf(target)).size)
		var report = SaveReport()
		for (listed in editedWindows(windowsOf(target)).map { it.incarnation }) {
			// Read again at its turn: a window closed while an earlier span saved took its draft with it.
			val window = windowsOf(target).firstOrNull { it.incarnation == listed && it.edited } ?: continue
			val sent = window.shown
			val descriptor = window.descriptor
			val answer = try {
				gate.saveSpan(target, descriptor.symbolId, descriptor.spanHash, sent)
			} catch (e: CancellationException) {
				throw e
			} catch (e: Exception) {
				DebugLog.log("Window", "save failed: ${e.message}")
				WorkspaceAnswer.Unreachable
			}
			report = when (answer) {
				is WorkspaceAnswer.Read -> {
					val saved = answer.value
					land(target, window, Landing.Folded { afterSave(it, sent, saved) })
					when (saved.outcome) {
						SAVE_SAVED -> report.copy(
							saved = report.saved + 1,
							joined = report.joined + if (saved.joined == true) 1 else 0,
							issues = report.issues + saved.issues.orEmpty(),
							unread = report.unread + if (saved.current == null && saved.gone != true) 1 else 0,
						)
						SAVE_STALE -> report.copy(stale = report.stale + 1)
						SAVE_REJECTED -> report.copy(refused = report.refused + (saved.reason ?: "Rejected"))
						// Includes an outcome this build does not know, which may have written.
						else -> report.copy(unknown = report.unknown + 1)
					}
				}
				is WorkspaceAnswer.Refused -> report.copy(refused = report.refused + answer.reason)
				WorkspaceAnswer.Unreachable -> report.copy(unknown = report.unknown + 1)
			}
		}
		report
	}.also { if (it.unknown > 0 || it.unread > 0) recheck(target) }

	/** Every session with a window open, which is what coming back to the app re-checks. */
	suspend fun recheckAll() {
		for (target in held.targets()) recheck(target)
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
		for (target in held.targets()) apply(target) { emptyList() }
		context.clear()
		drafts.clearAll()
	}
}
