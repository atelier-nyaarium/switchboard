package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer

/**
 * Every decision the window surface makes. None of it lives in a Composable: there is no
 * instrumentation test source set, so a rule written inside one is invisible to every gate.
 *
 * Scoped by SESSION, never by gateway. Two sessions of one gateway hold different workspaces, so a
 * gateway-keyed cache would serve one session's tree for the other.
 */

/** A session's workspace, which is what every window and read is scoped to. */
internal data class WorkspaceTarget(val gatewayId: String, val session: String) {
	/** Stable and self-describing, so a fence key reads as a session rather than a gateway. */
	val key: String get() = "$gatewayId/$session"
}

/**
 * What the window was drawn from. `spanHash` is the whole binding: a save is accepted only while the
 * span still hashes to this, so an edit elsewhere in the file leaves the window alone.
 */
internal data class WindowDescriptor(
	val symbolId: String,
	val module: String,
	val name: String,
	val startLine: Long,
	val endLine: Long,
	val spanHash: String,
)

internal fun descriptorOf(answer: WorkspaceSymbolSourceAnswer): WindowDescriptor =
	WindowDescriptor(
		symbolId = answer.symbolId,
		module = answer.module,
		name = answer.name,
		startLine = answer.startLine,
		endLine = answer.endLine,
		spanHash = answer.spanHash,
	)

/** One span the owner can read and, from the next release, edit. */
internal data class Window(
	val descriptor: WindowDescriptor,
	/** What the span held when the window was drawn. */
	val original: String,
	/** Null until the owner types; the draft is what a save or an ask would carry. */
	val draft: String? = null,
	val stale: Boolean = false,
) {
	val edited: Boolean get() = draft != null && draft != original
	val shown: String get() = draft ?: original
}

/**
 * What a refresh does, which is the one rule the whole staleness design rests on: refresh silently
 * when nothing of the owner's is lost, and show the banner only when it would discard their typing.
 */
internal sealed interface RefreshOutcome {
	/** Nothing of the owner's was at stake, so the new text simply replaces the old. */
	data class Adopted(val window: Window) : RefreshOutcome

	/** The owner has unsaved text here, so they decide rather than losing it. */
	data class Conflicts(val window: Window) : RefreshOutcome

	/** The span is unchanged, so there was nothing to do. */
	data object Unchanged : RefreshOutcome
}

/**
 * The rule, in one place. A caller never compares hashes itself.
 *
 * An unedited window adopts whatever is current, which is why the banner is never noise: on screen
 * means something is at stake.
 */
internal fun refreshWith(held: Window, fresh: WorkspaceSymbolSourceAnswer): RefreshOutcome {
	val descriptor = descriptorOf(fresh)
	if (descriptor.spanHash == held.descriptor.spanHash) return RefreshOutcome.Unchanged
	val next = Window(descriptor = descriptor, original = fresh.text)
	if (!held.edited) return RefreshOutcome.Adopted(next)
	return RefreshOutcome.Conflicts(held.copy(stale = true))
}

/** Which road a submit takes. The same text serves both; only the button differs. */
internal enum class SubmitRoad {
	/** Written verbatim. Arrives with the release that can save. */
	Save,

	/** Sent to the agent as a request, which it interprets and applies. */
	AgentApply,
}

/**
 * What the agent must be told, since a bare name is refused as ambiguous and an occurrence-numbered
 * id can renumber. The ORIGINAL rides along so the agent can refuse a span that moved under it.
 */
internal data class AgentRequest(val module: String, val symbolId: String, val original: String, val proposed: String)

internal fun agentRequestOf(window: Window): AgentRequest? {
	if (!window.edited) return null
	return AgentRequest(
		module = window.descriptor.module,
		symbolId = window.descriptor.symbolId,
		original = window.original,
		proposed = window.shown,
	)
}

/** What a tap does, so the screens carry no branching of their own. */
internal enum class OutlineTap {
	/** Short tap: read the symbol, its documentation and its knowledge. */
	OpenDetail,

	/** Long press: add a window for it, accumulating rather than replacing. */
	OpenWindow,
}

/** Hidden from a tree by the same rules the gateway refuses a read with, so the two never disagree. */
internal fun windowsFor(held: List<Window>, symbolId: String): Boolean = held.any { it.descriptor.symbolId == symbolId }

/** Accumulating, so a second long press adds rather than replaces, and a third of the same is a no-op. */
internal fun withWindow(held: List<Window>, added: Window): List<Window> =
	if (windowsFor(held, added.descriptor.symbolId)) held else held + added

internal fun withoutWindow(held: List<Window>, symbolId: String): List<Window> =
	held.filterNot { it.descriptor.symbolId == symbolId }

/** Only what the owner actually changed, so an untouched span is never submitted. */
internal fun editedWindows(held: List<Window>): List<Window> = held.filter { it.edited }
