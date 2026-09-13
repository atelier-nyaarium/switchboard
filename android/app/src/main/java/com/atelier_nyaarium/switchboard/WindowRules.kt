package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveIssue
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
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
 * Constructed rather than written as a literal: a control byte in source makes the file binary to
 * every tool that reads it, and compiles anyway.
 */
internal val KEY_SEPARATOR: String = Char(0x1e).toString()

/**
 * Joins two halves into one key. A symbol id CAN hold the separator, since Lexicon quotes a descriptor
 * name only for its own structural characters, so a declaration named with a control byte reaches here
 * raw, and a workspace file does not get to decide whether the tab crashes. Escaping keeps two
 * different pairs from joining to one key and sharing a fence counter.
 *
 * Two halves rather than a vararg: no arity can then coincide with another's key.
 */
internal fun separated(first: String, second: String): String = "${escaped(first)}$KEY_SEPARATOR${escaped(second)}"

private fun escaped(part: String): String =
	// The escape character first, or a written "%1e" and an escaped separator become one string.
	part.replace("%", "%25").replace(KEY_SEPARATOR, "%1e")

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
	/**
	 * Minted per open. A symbol id names which span, not WHICH OPENING of it, so work that began
	 * before a close and lands after the reopen would otherwise apply to the window that replaced it.
	 */
	override val incarnation: Long = 0,
) : Drafted {
	val edited: Boolean get() = draft != null && draft != original
	val shown: String get() = draft ?: original

	/** Which opening, holding which span: what an answer that awaited the gateway must still find. */
	val stamp: WindowStamp get() = WindowStamp(incarnation, descriptor.spanHash)

	override val draftKey: DraftKey get() = DraftKey.Span(descriptor.symbolId)

	override val heldDraft: HeldDraft? get() = draft?.let { HeldDraft(descriptor.spanHash, it) }
}

internal data class WindowStamp(val incarnation: Long, val spanHash: String)

/**
 * A window reopened over a draft. Typing done over another version of the span keeps that version's hash
 * and comes back stale, so a save is refused rather than landing it over what moved.
 */
internal fun restored(window: Window, held: HeldDraft?): Window =
	when {
		held == null -> window
		held.base == window.descriptor.spanHash -> window.copy(draft = held.text)
		else -> window.copy(descriptor = window.descriptor.copy(spanHash = held.base), draft = held.text, stale = true)
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
	// A copy, so the same window keeps its incarnation: refreshed, not replaced.
	val next = held.copy(descriptor = descriptor, original = fresh.text, draft = null, stale = false)
	// The file caught up with the draft, which is what an applied ask looks like. Nothing is at stake.
	if (!held.edited || fresh.text == held.shown) return RefreshOutcome.Adopted(next)
	return RefreshOutcome.Conflicts(held.copy(stale = true))
}

/**
 * A window after its save answered, judged against the window as held now. Null: the span no longer
 * resolves. Typing that arrived during the save stays as a draft. A save whose span could not be read
 * back leaves the window as it is, for a re-read to settle.
 */
internal fun afterSave(held: Window, sent: String, answer: WorkspaceSaveSpanAnswer): Window? {
	val fresh = answer.current
	return when (answer.outcome) {
		SAVE_SAVED -> when {
			fresh != null -> held.copy(
				descriptor = descriptorOf(fresh),
				original = fresh.text,
				draft = held.draft?.takeIf { typed -> typed != sent && typed != fresh.text },
				stale = false,
			)
			// Typing that arrived during the save is the owner's to copy or close, never dropped unseen.
			answer.gone == true -> if (held.draft != null && held.draft != sent) held.copy(stale = true) else null
			else -> held
		}
		// The refresh rule decides.
		SAVE_STALE -> when (val outcome = fresh?.let { refreshWith(held, it) }) {
			null -> held.copy(stale = true)
			RefreshOutcome.Unchanged -> held.copy(stale = true)
			is RefreshOutcome.Adopted -> outcome.window
			is RefreshOutcome.Conflicts -> outcome.window
		}
		else -> held
	}
}

internal const val SAVE_SAVED = "saved"
internal const val SAVE_STALE = "stale"
internal const val SAVE_REJECTED = "rejected"

/** What one Save tap did across the edited windows, never a Boolean. */
internal data class SaveReport(
	val saved: Int = 0,
	val stale: Int = 0,
	val refused: List<String> = emptyList(),
	/** No answer: the save may have landed, so the windows are re-read rather than assumed. */
	val unknown: Int = 0,
	/** Saved, but the span was not read back, so the windows are re-read. */
	val unread: Int = 0,
	/** Written into a transaction another session holds, which can still undo it. */
	val joined: Int = 0,
	val issues: List<WorkspaceSaveIssue> = emptyList(),
)

internal fun saveNotice(report: SaveReport): String? {
	val parts = buildList {
		if (report.saved > 0) add(if (report.saved == 1) "Saved" else "Saved ${report.saved}")
		if (report.joined > 0) add("${report.joined} in an open refactor")
		if (report.issues.isNotEmpty()) add(if (report.issues.size == 1) "1 issue" else "${report.issues.size} issues")
		if (report.stale > 0) add("${report.stale} stale")
		if (report.unknown > 0) add("${report.unknown} not confirmed")
		report.refused.distinct().forEach { add(it) }
	}
	return parts.takeIf { it.isNotEmpty() }?.joinToString(". ")
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

/**
 * A fence longer than any run of backticks inside, which is the markdown rule. A span can hold a
 * fenced block in a comment, and a three-backtick fence around it would end at that comment.
 */
internal fun fenceFor(text: String): String {
	var longest = 0
	var run = 0
	for (ch in text) {
		run = if (ch == '`') run + 1 else 0
		if (run > longest) longest = run
	}
	return "`".repeat(maxOf(3, longest + 1))
}

/**
 * What the owner's proposal reads as in the session's conversation. The ORIGINAL rides along because
 * an occurrence-numbered id can renumber, so the agent compares before it writes rather than trusting
 * the id alone. The wording invites a refusal, since a proposal may be pseudo code rather than final
 * text and this comparison is not under any lock.
 */
internal fun applyMessage(requests: List<AgentRequest>): String? {
	if (requests.isEmpty()) return null
	val spans = requests.joinToString("\n\n") { request ->
		val fence = fenceFor(request.original + request.proposed)
		listOf(
			"## ${request.module}",
			"`${request.symbolId}`",
			"",
			"As I was shown it:",
			"$fence\n${request.original}\n$fence",
			"",
			"What I want:",
			"$fence\n${request.proposed}\n$fence",
		).joinToString("\n")
	}
	val one = requests.size == 1
	return listOf(
		"I edited ${if (one) "a span" else "${requests.size} spans"} on my phone. Apply ${if (one) "it" else "them"}.",
		"",
		"Read each symbol by its id first. If what you read is not what I was shown, say so and leave it;",
		"the file may have moved under me. What I wrote may be pseudo code or a note rather than final",
		"text, so read it as intent and ask me if it is unclear.",
		"",
		spans,
	).joinToString("\n")
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
/**
 * A card's three parts. The span is text rather than lines because it is edited as one field: a
 * gutter cannot stay true beside a wrapping editor, and per-line fields would break selection and
 * paste across lines. The context keeps its numbers, where they can be trusted.
 */
internal data class WindowParts(val above: List<CodeLine>, val span: String, val below: List<CodeLine>)

internal fun windowParts(
	window: Window,
	file: List<String>?,
	context: Int = 2,
	previousEnd: Int? = null,
	nextStart: Int? = null,
): WindowParts {
	val start = window.descriptor.startLine.toInt()
	val end = window.descriptor.endLine.toInt()
	if (file == null) return WindowParts(emptyList(), window.shown, emptyList())
	// Context stops at the neighbouring window, or the gap between two cards would count lines both draw.
	val first = maxOf(1, start - context, (previousEnd ?: 0) + 1)
	val last = minOf(file.size, end + context, (nextStart ?: Int.MAX_VALUE) - 1)
	// Indexed directly, with no default: a line the file does not hold is a bug, not a blank row.
	val above = (first until minOf(start, file.size + 1)).map { CodeLine(it, file[it - 1]) }
	val below = (end + 1..last).map { CodeLine(it, file[it - 1]) }
	return WindowParts(above, window.shown, below)
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
