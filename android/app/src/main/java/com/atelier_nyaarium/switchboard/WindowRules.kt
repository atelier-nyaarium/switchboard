package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer

/**
 * Every decision the window surface makes. None of it lives in a Composable: there is no
 * instrumentation test source set, so a rule written inside one is invisible to every gate.
 *
 * Scoped by SESSION, never by gateway. Two sessions of one gateway hold different workspaces, so a
 * gateway-keyed cache would serve one session's tree for the other.
 */

/**
 * A session's workspace, which is what every window and read is scoped to. `address` is the session's
 * qualified `domain.gateway.spawn.session`, the only form the gateway's console handler accepts;
 * `gatewayId` is which Gateway the op is posted to, which a cross-Domain address does not name.
 */
internal data class WorkspaceTarget(val gatewayId: String, val address: String) {
	val key: String get() = "$gatewayId/$address"
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

internal fun holdsWindow(held: List<Window>, symbolId: String): Boolean = held.any { it.descriptor.symbolId == symbolId }

/** Accumulating, so a second long press adds rather than replaces, and a third of the same is a no-op. */
internal fun withWindow(held: List<Window>, added: Window): List<Window> =
	if (holdsWindow(held, added.descriptor.symbolId)) held else held + added

internal fun withoutWindow(held: List<Window>, symbolId: String): List<Window> =
	held.filterNot { it.descriptor.symbolId == symbolId }

/** Only what the owner actually changed, so an untouched span is never submitted. */
internal fun editedWindows(held: List<Window>): List<Window> = held.filter { it.edited }

/** One rendered line: its number as the file counts them, and whether the blue band marks it. */
internal data class CodeLine(val number: Int, val text: String, val banded: Boolean = false)

/**
 * A symbol's own source, numbered as the file numbers it. Unbanded: the band says which lines of a
 * surrounding file are in range, and on its own there is nothing for it to say.
 */
internal fun spanLines(answer: WorkspaceSymbolSourceAnswer): List<CodeLine> =
	answer.text.split("\n").mapIndexed { i, text -> CodeLine(answer.startLine.toInt() + i, text) }

/**
 * A window's lines, with `context` lines of the file either side. Without the file it is the span
 * alone, which is what an unreadable or oversized file leaves.
 *
 * The trailing numbers are the file's, not the draft's, so a draft that grew shows a jump rather
 * than numbers the file does not have.
 */
internal fun windowLines(
	window: Window,
	file: List<String>?,
	context: Int = 2,
	previousEnd: Int? = null,
	nextStart: Int? = null,
): List<CodeLine> {
	val start = window.descriptor.startLine.toInt()
	val end = window.descriptor.endLine.toInt()
	val span = window.shown.split("\n").mapIndexed { i, text -> CodeLine(start + i, text, true) }
	if (file == null) return span
	// Context stops at the neighbouring window, or the gap between two cards would count lines both draw.
	val first = maxOf(1, start - context, (previousEnd ?: 0) + 1)
	val last = minOf(file.size, end + context, (nextStart ?: Int.MAX_VALUE) - 1)
	// Indexed directly, with no default: a line the file does not hold is a bug, not a blank row.
	val above = (first until minOf(start, file.size + 1)).map { CodeLine(it, file[it - 1]) }
	val below = (end + 1..last).map { CodeLine(it, file[it - 1]) }
	return above + span + below
}

/** How many lines the viewer skipped between two windows, or null when they touch. */
internal fun gapBetween(above: Window, below: Window): Int? {
	val skipped = below.descriptor.startLine.toInt() - above.descriptor.endLine.toInt() - 1
	return skipped.takeIf { it > 0 }
}

/** Windows in file order, since they were opened in tap order and are drawn down one file. */
internal fun inFileOrder(held: List<Window>): List<Window> =
	held.sortedWith(compareBy({ it.descriptor.module }, { it.descriptor.startLine }))

/** One outline chip. A null kind is every symbol, which is why the field is nullable rather than "". */
internal data class OutlineKind(val kind: String?, val label: String, val count: Int)

/**
 * The chips a file earns, commonest first. The labels are Lexicon's own kind words rather than a table
 * of abbreviations here, which would go stale the moment a language names a kind this does not know.
 */
internal fun outlineKinds(symbols: List<WorkspaceOutlineSymbol>): List<OutlineKind> {
	val counted = symbols.groupBy { it.symbolKind }
		.map { (kind, rows) -> OutlineKind(kind, kind.replaceFirstChar { it.uppercase() }, rows.size) }
		.sortedWith(compareByDescending<OutlineKind> { it.count }.thenBy { it.label })
	return listOf(OutlineKind(null, "All", symbols.size)) + counted
}

internal fun outlineOfKind(symbols: List<WorkspaceOutlineSymbol>, kind: String?): List<WorkspaceOutlineSymbol> =
	if (kind == null) symbols else symbols.filter { it.symbolKind == kind }
