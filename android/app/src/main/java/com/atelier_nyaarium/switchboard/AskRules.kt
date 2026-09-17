package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeEntry
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeQuestion
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeSymbol

/**
 * Every decision the Ask sheet and the Knowledge section make, outside a Composable so a gate can
 * reach it: the defaults, the counts, what a send picks, the containment order, the message and its
 * budget, the progress and the row words.
 */

internal val QUESTION_CLASSES = listOf("describe", "why", "relate", "contract", "effects", "usage")

internal enum class AskScope { SYMBOL, MEMBERS, FILE }

internal enum class Include { NOT_RECORDED, WEAK, ASKED, LOCALS }

/** What the sheet was opened on, which every scope is read relative to. */
internal data class AskSubject(val target: WorkspaceTarget, val symbolId: String, val name: String, val module: String)

/** `root` is the workspace root the counts were read under, stamped on the first read. */
internal data class AskSelection(
	val scope: AskScope,
	val questions: Set<String>,
	val include: Set<Include>,
	val root: String? = null,
)

////////////////////////////////
//  Selection

internal fun defaultSelection(question: String?): AskSelection =
	AskSelection(
		scope = AskScope.SYMBOL,
		questions = question?.let { setOf(it) } ?: QUESTION_CLASSES.toSet(),
		include = setOf(Include.NOT_RECORDED, Include.WEAK),
	)

/** Another root is another workspace, so its counts say nothing about what was ticked under the last. */
internal fun selectionForRoot(selection: AskSelection, root: String): AskSelection =
	when (selection.root) {
		null, root -> selection.copy(root = root)
		else -> AskSelection(
			scope = AskScope.SYMBOL,
			questions = selection.questions,
			include = setOf(Include.NOT_RECORDED, Include.WEAK),
			root = root,
		)
	}

/** One symbol is the root entry of its own Members read, so both scopes share one read. */
internal fun readTarget(subject: AskSubject, scope: AskScope): WorkspaceKnowledgeScopeTarget =
	when (scope) {
		AskScope.SYMBOL, AskScope.MEMBERS -> WorkspaceKnowledgeScopeTarget.Members(subject.symbolId)
		AskScope.FILE -> WorkspaceKnowledgeScopeTarget.File(subject.module)
	}

internal fun scopeSubject(subject: AskSubject, scope: AskScope): String =
	separated(scope.name, if (scope == AskScope.FILE) subject.module else subject.symbolId)

internal fun requestKey(subject: AskSubject, root: String, scope: AskScope): RequestKey =
	RequestKey(subject.target.address, RequestKind.KNOWLEDGE, separated(root, scopeSubject(subject, scope)))

private const val SCOPE_UNIT = "declarations"

internal sealed interface ScopeState {
	data class Listed(val answer: WorkspaceKnowledgeScopeAnswer) : ScopeState

	/** Loading, refused, too large or unreachable: what the sheet draws in place of its body. */
	data class NotRead(val state: FacetState<Nothing>) : ScopeState
}

internal fun scopeState(answer: WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>>?): ScopeState =
	when (answer) {
		null -> ScopeState.NotRead(FacetState.Loading)
		is WorkspaceAnswer.Refused -> ScopeState.NotRead(refusalOf(answer.reason))
		WorkspaceAnswer.Unreachable -> ScopeState.NotRead(FacetState.Unreachable)
		is WorkspaceAnswer.Read -> when (val listing = answer.value) {
			is WorkspaceListing.TooLarge ->
				ScopeState.NotRead(FacetState.TooLarge(tooLargeText(SCOPE_UNIT, listing.rows, listing.bytes)))
			is WorkspaceListing.Listed -> ScopeState.Listed(listing.value)
		}
	}

internal fun scopeSymbols(
	answer: WorkspaceKnowledgeScopeAnswer,
	subject: AskSubject,
	scope: AskScope,
): List<WorkspaceScopeSymbol> =
	when (scope) {
		AskScope.SYMBOL -> listOfNotNull(rootEntry(answer, subject))
		AskScope.MEMBERS, AskScope.FILE -> answer.symbols
	}

private fun rootEntry(answer: WorkspaceKnowledgeScopeAnswer, subject: AskSubject): WorkspaceScopeSymbol? =
	answer.symbols.firstOrNull { it.symbolId == subject.symbolId }

////////////////////////////////
//  Picks

internal enum class PairState { MISSING, WEAK, HEALTHY }

/** Shaky counts as weak: an answer its own citations no longer support is not one to leave. */
internal fun pairState(question: WorkspaceScopeQuestion): PairState =
	when {
		question.createdAt == null -> PairState.MISSING
		question.stale == true || question.doubted == true || question.thin == true || question.shaky == true ->
			PairState.WEAK
		else -> PairState.HEALTHY
	}

internal fun interface AskedLookup {
	fun asked(symbolId: String, question: String): Boolean
}

internal data class AskPick(val symbol: WorkspaceScopeSymbol, val questions: List<String>)

/** Answer order, which Lexicon walks leaves first, so a container's answers can cite its members'. */
internal fun picks(symbols: List<WorkspaceScopeSymbol>, selection: AskSelection, asked: AskedLookup): List<AskPick> =
	symbols.mapNotNull { symbol ->
		val chosen = QUESTION_CLASSES.filter { name ->
			name in selection.questions && wanted(symbol, name, selection.include, asked)
		}
		if (chosen.isEmpty()) null else AskPick(symbol, chosen)
	}

/** A pair the answer does not carry cannot be judged, so it is never picked. */
private fun wanted(symbol: WorkspaceScopeSymbol, question: String, include: Set<Include>, asked: AskedLookup): Boolean {
	val entry = symbol.questions.firstOrNull { it.question == question } ?: return false
	return included(pairState(entry), asked.asked(symbol.symbolId, question), include)
}

/** Each pair's `createdAt` as the read the send used carried it, which is what clears it later. */
internal fun askedPairs(address: String, answer: WorkspaceKnowledgeScopeAnswer, picks: List<AskPick>): Map<AskedKey, Double?> =
	buildMap {
		for (pick in picks) {
			for (question in pick.questions) {
				val key = AskedKey(address, answer.root, pick.symbol.symbolId, question)
				put(key, pick.symbol.questions.firstOrNull { it.question == question }?.createdAt)
			}
		}
	}

private fun included(state: PairState, asked: Boolean, include: Set<Include>): Boolean {
	val byState = when (state) {
		PairState.MISSING -> Include.NOT_RECORDED in include
		PairState.WEAK -> Include.WEAK in include
		PairState.HEALTHY -> false
	}
	return byState && (!asked || Include.ASKED in include)
}

////////////////////////////////
//  Counts

internal data class AskCounts(
	val scopeSymbols: Map<AskScope, Int?>,
	val perQuestion: Map<String, Int>,
	val notRecorded: Int,
	val weak: Int,
	val asked: Int,
	val locals: Int?,
	val answers: Int,
	val symbols: Int,
)

/**
 * `selected` is the read the send would use, which carries locals when that row is ticked. The locals
 * count itself comes from the plain read, or ticking the row would change the number beside it.
 */
internal fun askCounts(
	members: WorkspaceKnowledgeScopeAnswer?,
	file: WorkspaceKnowledgeScopeAnswer?,
	selected: WorkspaceKnowledgeScopeAnswer?,
	subject: AskSubject,
	selection: AskSelection,
	asked: AskedLookup,
): AskCounts {
	val symbols = selected?.let { scopeSymbols(it, subject, selection.scope) }.orEmpty()
	val picked = picks(symbols, selection, asked)
	val perQuestion = mutableMapOf<String, Int>()
	var notRecorded = 0
	var weak = 0
	var out = 0
	for (symbol in symbols) {
		for (entry in symbol.questions) {
			val name = entry.question
			if (name !in QUESTION_CLASSES) continue
			val state = pairState(entry)
			val isAsked = asked.asked(symbol.symbolId, name)
			if (name in selection.questions) {
				if (state == PairState.MISSING) notRecorded++
				if (state == PairState.WEAK) weak++
				if (isAsked) out++
			}
			if (included(state, isAsked, selection.include)) perQuestion[name] = (perQuestion[name] ?: 0) + 1
		}
	}
	return AskCounts(
		scopeSymbols = mapOf(
			AskScope.SYMBOL to members?.let { if (rootEntry(it, subject) == null) 0 else 1 },
			AskScope.MEMBERS to members?.symbols?.size,
			AskScope.FILE to file?.symbols?.size,
		),
		perQuestion = perQuestion,
		notRecorded = notRecorded,
		weak = weak,
		asked = out,
		locals = when (selection.scope) {
			AskScope.SYMBOL -> null
			AskScope.MEMBERS -> members?.localsExcluded?.toInt()
			AskScope.FILE -> file?.localsExcluded?.toInt()
		},
		answers = picked.sumOf { it.questions.size },
		symbols = picked.size,
	)
}

internal fun summaryText(counts: AskCounts): String {
	if (counts.answers == 0) return "Nothing to ask"
	return "${counted(counts.answers, "answer")} across ${counted(counts.symbols, "symbol")}"
}

private const val ORDER_SEPARATOR = " › "

/** Null under two symbols: one name is not an order. Ends kept, middle elided. */
internal fun orderLine(picks: List<AskPick>, max: Int = 6): String? {
	if (picks.size < 2) return null
	val names = picks.map { it.symbol.name }
	if (names.size <= max) return names.joinToString(ORDER_SEPARATOR)
	val head = max / 2
	return (names.take(head) + "…" + names.takeLast(max - head - 1)).joinToString(ORDER_SEPARATOR)
}

private fun counted(count: Int, word: String): String = "${countText(count)} $word" + if (count == 1) "" else "s"

////////////////////////////////
//  Message

internal const val ASK_MESSAGE_BUDGET_BYTES = 256_000

private val HOW_LINES = listOf(
	"- For each symbol, call `symbol_facts` for its fact ids, then read the code at its declaration and at its " +
		"reference sites. The ids are locations; the answer comes from the code.",
	"- One `record_answer` per question, citing at least one fact beyond the declaration.",
	"- Members before their container: the container's answers cite its members' answer ids.",
	"- A stale answer that still holds takes `reaffirm_answer` instead.",
	"- Sibling branches may go to subagents, each returning the answer ids it recorded.",
	"- One reply at the end: how many you recorded and reaffirmed, and each answer you could not give, with why.",
)

private const val NOTHING_HERE = ": nothing to record here. "

internal fun askMessage(
	subject: AskSubject,
	scope: AskScope,
	answer: WorkspaceKnowledgeScopeAnswer,
	picks: List<AskPick>,
): String {
	val answers = picks.sumOf { it.questions.size }
	val intent = "Record Lexicon knowledge for ${subjectText(subject, scope)} in ${codeSpan(answer.module)}: " +
		"${counted(answers, "answer")} across ${counted(picks.size, "symbol")}. " +
		"I chose this set on my phone, so record every one without asking me first."
	return (listOf(intent, "", "How:") + HOW_LINES + listOf("", "Tree:") + treeLines(answer, picks)).joinToString("\n")
}

internal fun overBudget(text: String): Int? =
	text.toByteArray(Charsets.UTF_8).size.takeIf { it > ASK_MESSAGE_BUDGET_BYTES }

private fun subjectText(subject: AskSubject, scope: AskScope): String =
	when (scope) {
		AskScope.SYMBOL -> codeSpan(subject.name)
		AskScope.MEMBERS -> "${codeSpan(subject.name)} and its members"
		AskScope.FILE -> "every declaration"
	}

/** Containment, not the answer's post-order: a container the picks sit under is drawn above them. */
private fun treeLines(answer: WorkspaceKnowledgeScopeAnswer, picks: List<AskPick>): List<String> {
	val chosen = picks.associate { it.symbol.symbolId to it.questions }
	val byId = answer.symbols.associateBy { it.symbolId }
	val drawn = LinkedHashSet<String>()
	for (id in chosen.keys) {
		var at: String? = id
		while (at != null && drawn.add(at)) at = byId[at]?.containerId?.takeIf { it in byId }
	}
	val held = answer.symbols.filter { it.symbolId in drawn }
	val children = held.groupBy { it.containerId }
	val lines = mutableListOf<String>()
	fun walk(symbol: WorkspaceScopeSymbol, depth: Int) {
		lines += nodeLine(symbol, chosen[symbol.symbolId], depth)
		children[symbol.symbolId].orEmpty().forEach { walk(it, depth + 1) }
	}
	held.filter { it.containerId == null || it.containerId !in drawn }.forEach { walk(it, 0) }
	return lines
}

private fun nodeLine(symbol: WorkspaceScopeSymbol, questions: List<String>?, depth: Int): String {
	val body = questions?.let { ": ${it.joinToString(", ")}. " } ?: NOTHING_HERE
	return "  ".repeat(depth) + "- " + codeSpan(symbol.name) + " " + symbol.symbolKind + body + codeSpan(symbol.symbolId)
}

/**
 * The shortest fence longer than any backtick run inside, which is CommonMark's inline rule. A block
 * fence never goes under three, so `fenceFor` is not it. The pad keeps a leading or trailing backtick
 * out of the fence; CommonMark strips one space from each end.
 */
internal fun codeSpan(text: String): String {
	var longest = 0
	var run = 0
	for (character in text) {
		run = if (character == '`') run + 1 else 0
		if (run > longest) longest = run
	}
	val pad = if (text.startsWith("`") || text.endsWith("`")) " " else ""
	val fence = "`".repeat(longest + 1)
	return "$fence$pad$text$pad$fence"
}

////////////////////////////////
//  Progress and rows

internal data class ProgressRow(val symbolId: String, val name: String, val recorded: List<String>, val out: Int)

internal data class AskProgress(
	val sent: Int,
	val recorded: Int,
	val sentAt: Long,
	val oneSymbol: Boolean,
	val rows: List<ProgressRow>,
)

/** Null once nothing is out, so the header stops showing a send that is done. */
internal fun progressOf(send: AskSend?, answer: WorkspaceKnowledgeScopeAnswer?, now: Long): AskProgress? {
	if (send == null || now - send.sentAt >= ASKED_TTL_MS) return null
	if (send.pairs.keys.all { it in send.recorded }) return null
	val names = answer?.symbols?.associate { it.symbolId to it.name }.orEmpty()
	val rows = send.pairs.keys.map { it.symbolId }.distinct().map { id ->
		val mine = send.pairs.keys.filter { it.symbolId == id }
		ProgressRow(
			symbolId = id,
			name = names[id] ?: id,
			recorded = QUESTION_CLASSES.filter { question -> mine.any { it.question == question && it in send.recorded } },
			out = mine.count { it !in send.recorded },
		)
	}
	return AskProgress(
		sent = send.pairs.size,
		recorded = send.recorded.size,
		sentAt = send.sentAt,
		oneSymbol = rows.size == 1,
		rows = rows,
	)
}

internal fun progressText(progress: AskProgress, now: Long): String =
	if (progress.oneSymbol) {
		"Asked ${agoText(progress.sentAt, now)}"
	} else {
		"${countText(progress.recorded)} of ${countText(progress.sent)} recorded"
	}

internal enum class RowWord { NOT_RECORDED, ASKED, RECORDED }

internal fun rowWord(entry: WorkspaceScopeQuestion?, prose: String?, asked: Boolean): RowWord =
	when {
		prose != null || entry?.createdAt != null -> RowWord.RECORDED
		asked -> RowWord.ASKED
		else -> RowWord.NOT_RECORDED
	}

/** The scope read knows every question; the detail's own answers carry only what is recorded. */
internal fun recordedText(questions: List<WorkspaceScopeQuestion>?, answers: List<WorkspaceKnowledgeEntry>?): String {
	val of = questions?.size ?: QUESTION_CLASSES.size
	val recorded = questions?.count { it.createdAt != null } ?: answers?.count { it.prose != null } ?: 0
	return "${countText(recorded)} of ${countText(of)} recorded"
}
