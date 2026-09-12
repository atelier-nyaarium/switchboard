package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry

/**
 * Every decision the window surface makes, outside a Composable so a gate can reach it.
 *
 * Scoped by SESSION, never by gateway: two sessions of one gateway hold different workspaces.
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
 * Joins halves into one key with the ASCII record separator, which no address, module path or symbol
 * id holds. Constructed rather than written as a literal: a control byte in source makes the file
 * binary to every tool that reads it, and compiles anyway.
 */
internal val KEY_SEPARATOR: String = Char(0x1e).toString()

internal fun separated(vararg parts: String): String = parts.joinToString(KEY_SEPARATOR)

/**
 * What a read fills, which is what a fence key must name. Two reads of one session but different
 * slots do not supersede each other; a caller cannot invent a key, since there is no string to pass.
 */
internal sealed interface ReadSlot {
	val key: String

	data object Tree : ReadSlot {
		override val key = "tree"
	}

	data object File : ReadSlot {
		override val key = "file"
	}

	data object Outline : ReadSlot {
		override val key = "outline"
	}

	data object Source : ReadSlot {
		override val key = "source"
	}

	data object Knowledge : ReadSlot {
		override val key = "knowledge"
	}

	/** One per symbol: opening two windows at once is two reads, not one racing itself. */
	data class Span(val symbolId: String) : ReadSlot {
		override val key get() = "span:$symbolId"
	}
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

/** One span of one file, as the owner is shown it. */
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

/**
 * Whether the drafts on disk should still hold this text. Memory is the authority, so a save queued
 * before a close or a refresh does not land after the clear that was meant to discard it.
 */
internal fun holdsDraft(held: List<Window>, symbolId: String, text: String): Boolean =
	held.any { it.descriptor.symbolId == symbolId && it.draft == text }

/** Only what the owner actually changed, so an untouched span is never submitted. */
internal fun editedWindows(held: List<Window>): List<Window> = held.filter { it.edited }

/**
 * One rendered line: its number as the file counts them, whether the blue band marks it, and the
 * half-open range of `text` the amber mark covers.
 */
internal data class CodeLine(
	val number: Int,
	val text: String,
	val banded: Boolean = false,
	val mark: IntRange? = null,
)

/**
 * Where the symbol's own name sits in a line, which is what the amber mark covers. The ref viewer
 * marks the same thing; here the range is found by name, since the answer carries no name range.
 *
 * Only a whole word counts, or `f` would mark the `f` inside `offset`.
 */
internal fun markOf(text: String, name: String): IntRange? {
	if (name.isEmpty()) return null
	var from = text.indexOf(name)
	while (from >= 0) {
		val before = text.getOrNull(from - 1)
		val after = text.getOrNull(from + name.length)
		if (!before.isNamePart() && !after.isNamePart()) return from until from + name.length
		from = text.indexOf(name, from + 1)
	}
	return null
}

private fun Char?.isNamePart(): Boolean = this != null && (isLetterOrDigit() || this == '_' || this == '$')

/** A whole file's lines, numbered from one. */
internal fun fileLines(text: String): List<CodeLine> = text.split("\n").mapIndexed { i, line -> CodeLine(i + 1, line) }

/**
 * A symbol's own source, numbered as the file numbers it. Unbanded: the band says which lines of a
 * surrounding file are in range, and on its own there is nothing for it to say.
 */
internal fun spanLines(answer: WorkspaceSymbolSourceAnswer): List<CodeLine> =
	marked(answer.text.split("\n").mapIndexed { i, text -> CodeLine(answer.startLine.toInt() + i, text) }, answer.name)

/** Once, on the first line holding it: the declaration rather than a use. */
private fun marked(lines: List<CodeLine>, name: String): List<CodeLine> {
	val at = lines.indexOfFirst { markOf(it.text, name) != null }
	if (at < 0) return lines
	return lines.mapIndexed { i, line -> if (i == at) line.copy(mark = markOf(line.text, name)) else line }
}

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
	val span = marked(
		window.shown.split("\n").mapIndexed { i, text -> CodeLine(start + i, text, true) },
		window.descriptor.name,
	)
	if (file == null) return span
	// Context stops at the neighbouring window, or the gap between two cards would count lines both draw.
	val first = maxOf(1, start - context, (previousEnd ?: 0) + 1)
	val last = minOf(file.size, end + context, (nextStart ?: Int.MAX_VALUE) - 1)
	// Indexed directly, with no default: a line the file does not hold is a bug, not a blank row.
	val above = (first until minOf(start, file.size + 1)).map { CodeLine(it, file[it - 1]) }
	val below = (end + 1..last).map { CodeLine(it, file[it - 1]) }
	return above + span + below
}

/**
 * How many lines neither card draws between two windows, or null when the two together cover the gap.
 * Counting the raw distance would announce a skip over lines both cards are showing as context.
 */
internal fun gapBetween(above: Window, below: Window, context: Int = 2): Int? {
	val start = below.descriptor.startLine.toInt()
	val end = above.descriptor.endLine.toInt()
	val lastDrawn = minOf(end + context, start - 1)
	val firstDrawn = maxOf(start - context, end + 1)
	return (firstDrawn - lastDrawn - 1).takeIf { it > 0 }
}

/** Windows in file order, since they were opened in tap order and are drawn down one file. */
internal fun inFileOrder(held: List<Window>): List<Window> =
	held.sortedWith(compareBy({ it.descriptor.module }, { it.descriptor.startLine }))

/** A null kind is every symbol. */
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

/**
 * How deep each row sits under its container, by walking `containerId` up. A container the answer
 * does not carry, and a cycle, both indent nothing rather than guessing or walking forever.
 *
 * Answered for the whole outline at once: per row it rebuilt the index, which is a map of every
 * symbol built once per symbol.
 */
internal fun outlineDepths(symbols: List<WorkspaceOutlineSymbol>): Map<String, Int> {
	val byId = symbols.associateBy { it.symbolId }
	return symbols.associate { symbol ->
		val seen = mutableSetOf(symbol.symbolId)
		var depth = 0
		var container = symbol.containerId
		while (container != null && byId.containsKey(container) && seen.add(container)) {
			depth++
			container = byId.getValue(container).containerId
		}
		symbol.symbolId to depth
	}
}

/** A tap on a tree row: a directory opens, a file goes to its outline. */
internal fun opensDirectory(entry: WorkspaceTreeEntry): Boolean = entry.directory

/** A directory counts its children, a file shows its size, and neither shows a missing one as zero. */
internal fun treeMeta(entry: WorkspaceTreeEntry): String? =
	if (entry.directory) entry.children?.toString() else prettySize(entry.bytes)

/** The files a window view reads for context, each once however many windows it holds. */
internal fun modulesOf(windows: List<Window>): List<String> = windows.map { it.descriptor.module }.distinct()

/** What bounds a window's context: the neighbours either side, but only within the same file. */
internal fun neighbourBounds(ordered: List<Window>, index: Int): Pair<Int?, Int?> {
	val module = ordered[index].descriptor.module
	val above = ordered.getOrNull(index - 1)?.takeIf { it.descriptor.module == module }
	val below = ordered.getOrNull(index + 1)?.takeIf { it.descriptor.module == module }
	return above?.descriptor?.endLine?.toInt() to below?.descriptor?.startLine?.toInt()
}

/** A module is named above its first window, the first included, or one file would go unnamed. */
internal fun opensModule(ordered: List<Window>, index: Int): Boolean {
	val above = ordered.getOrNull(index - 1) ?: return true
	return above.descriptor.module != ordered[index].descriptor.module
}
