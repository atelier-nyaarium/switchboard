package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeQuestion
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeSymbol

/**
 * Every decision the Ask sheet and the Knowledge section make, outside a Composable so a gate can
 * reach it: the defaults, the counts, what a send picks, the containment order, the message's prose
 * and its budget, the progress and the row words. `AskGrammar` owns the tree's own shape.
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

/** The selected scope's read says which workspace the counts are under; another landed read stands in. */
internal fun scopeRoot(members: String?, file: String?, scope: AskScope): String? =
	when (scope) {
		AskScope.SYMBOL, AskScope.MEMBERS -> members ?: file
		AskScope.FILE -> file ?: members
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

/** The one road from a read to what the ledger settles against, so the wire has one reader. */
internal fun askObservation(address: String, answer: WorkspaceKnowledgeScopeAnswer): AskObservation =
	AskObservation(
		address = address,
		root = answer.root,
		listed = buildMap {
			for (symbol in answer.symbols) {
				for (entry in symbol.questions) {
					put(AskedKey(address, answer.root, symbol.symbolId, entry.question), entry.createdAt)
				}
			}
		},
	)

/** The owner committed to a set, so one that changed without growing is refused too. */
internal fun reviewChanged(shown: Set<AskedKey>, fresh: Set<AskedKey>): Boolean = shown != fresh

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
	val tree = askTreeLines(askNodes(answer, picks))
	return (listOf(intent, "", "How:") + HOW_LINES + listOf("", "Tree:") + tree).joinToString("\n")
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
private fun askNodes(answer: WorkspaceKnowledgeScopeAnswer, picks: List<AskPick>): List<AskNode> {
	val chosen = picks.associate { it.symbol.symbolId to it.questions }
	val byId = answer.symbols.associateBy { it.symbolId }
	val drawn = LinkedHashSet<String>()
	for (id in chosen.keys) {
		var at: String? = id
		while (at != null && drawn.add(at)) at = byId[at]?.containerId?.takeIf { it in byId }
	}
	val held = answer.symbols.filter { it.symbolId in drawn }
	val children = held.groupBy { it.containerId }
	fun nodeOf(symbol: WorkspaceScopeSymbol): AskNode = AskNode(
		name = symbol.name,
		kind = symbol.symbolKind,
		symbolId = symbol.symbolId,
		questions = chosen[symbol.symbolId].orEmpty(),
		children = children[symbol.symbolId].orEmpty().map { nodeOf(it) },
	)
	return held.filter { it.containerId == null || it.containerId !in drawn }.map { nodeOf(it) }
}

////////////////////////////////
//  The claim

/** What one preflight decided: the claim a send submits, or the word that refuses it. */
internal sealed interface AskClaimed {
	data class Refused(val sent: AskSent) : AskClaimed
}

/** Everything one send needs, so recording and submitting decide nothing of their own. */
internal data class AskClaim(
	val address: String,
	val root: String,
	val scopeSubject: String,
	val key: RequestKey,
	val pairs: Map<AskedKey, Double?>,
	val answers: Int,
	val text: String,
) : AskClaimed

/**
 * One read to one claim: the pairs, the count, the root, the request key and the message text are all
 * picked here, so the sheet's offer and the send's claim read the same rules.
 */
internal fun askClaim(
	subject: AskSubject,
	selection: AskSelection,
	answer: WorkspaceKnowledgeScopeAnswer,
	reviewed: Set<AskedKey>,
	asked: AskedLookup,
): AskClaimed {
	if (answer.root != selection.root) return AskClaimed.Refused(AskSent.RootChanged)
	val address = subject.target.address
	val picked = picks(scopeSymbols(answer, subject, selection.scope), selection, asked)
	val answers = picked.sumOf { it.questions.size }
	if (answers == 0) return AskClaimed.Refused(AskSent.NothingToAsk)
	val pairs = askedPairs(address, answer, picked)
	if (reviewChanged(reviewed, pairs.keys)) return AskClaimed.Refused(AskSent.Changed)
	val text = askMessage(subject, selection.scope, answer, picked)
	overBudget(text)?.let { return AskClaimed.Refused(AskSent.TooLarge(it)) }
	return AskClaim(
		address = address,
		root = answer.root,
		scopeSubject = scopeSubject(subject, selection.scope),
		key = requestKey(subject, answer.root, selection.scope),
		pairs = pairs,
		answers = answers,
		text = text,
	)
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

internal data class ProgressLine(val text: String, val word: RowWord)

/** A row reads the questions it recorded, or the one word for a row nothing has come back on. */
internal fun progressLine(row: ProgressRow): ProgressLine =
	if (row.recorded.isEmpty()) {
		ProgressLine(rowWordText(RowWord.ASKED), RowWord.ASKED)
	} else {
		ProgressLine(row.recorded.joinToString(", "), RowWord.RECORDED)
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

internal fun rowWordText(word: RowWord): String =
	when (word) {
		RowWord.NOT_RECORDED -> "not recorded"
		RowWord.ASKED -> "asked"
		RowWord.RECORDED -> "recorded"
	}

/** A card's prose already shows it is recorded. */
internal fun cardWordText(word: RowWord): String? = if (word == RowWord.RECORDED) null else rowWordText(word)

/**
 * A question row: the detail's answers carry the prose, the scope read says what is still out.
 * A recorded row has nothing left to ask, so it does not open.
 */
internal data class AskRow(
	val question: String,
	val prose: String?,
	val badges: List<KnowledgeBadge>,
	val word: RowWord,
	val opens: Boolean,
)

/** A dissolved describe is page text, so it has no card. */
internal fun askRows(
	rows: List<KnowledgeRow>,
	symbolId: String,
	scope: WorkspaceScopeSymbol?,
	asked: AskedLookup,
): List<AskRow> =
	rows.mapNotNull { row ->
		if (dissolves(row)) return@mapNotNull null
		val word = rowWord(
			scope?.questions?.firstOrNull { it.question == row.question },
			row.prose,
			asked.asked(symbolId, row.question),
		)
		AskRow(
			question = row.question,
			prose = row.prose,
			badges = row.badges,
			word = word,
			opens = word != RowWord.RECORDED,
		)
	}

internal fun interface SendLookup {
	fun latest(scopeSubject: String): AskSend?
}

/** The newest send made from this subject, whichever scope it was made at. */
internal fun pageSend(subject: AskSubject, sends: SendLookup): AskSend? =
	AskScope.entries.mapNotNull { sends.latest(scopeSubject(subject, it)) }.maxByOrNull { it.id }

/** One symbol and its members share a read, so only a whole-file send moves which scope a page keeps. */
internal fun pageScope(subject: AskSubject, send: AskSend?): AskScope =
	if (send?.scopeSubject == scopeSubject(subject, AskScope.FILE)) AskScope.FILE else AskScope.MEMBERS

////////////////////////////////
//  The sheet

internal fun scopeLabel(scope: AskScope): String =
	when (scope) {
		AskScope.SYMBOL -> "This symbol"
		AskScope.MEMBERS -> "With members"
		AskScope.FILE -> "Whole file"
	}

internal fun scopeNote(symbols: Int?): String? = symbols?.let { counted(it, "symbol") }

internal data class QuestionChip(val question: String, val label: String, val on: Boolean)

/** One symbol's chips would each read 1, which the summary under them already says. */
internal fun questionChips(counts: AskCounts, selection: AskSelection): List<QuestionChip> {
	val many = (counts.scopeSymbols[selection.scope] ?: 0) > 1
	return QUESTION_CLASSES.map { question ->
		val titled = question.replaceFirstChar { it.uppercase() }
		QuestionChip(
			question = question,
			label = if (many) "$titled ${countText(counts.perQuestion[question] ?: 0)}" else titled,
			on = question in selection.questions,
		)
	}
}

internal data class IncludeRow(val include: Include, val label: String, val count: Int, val on: Boolean)

/** The locals row is hidden where the scope excludes none, which is one symbol on its own. */
internal fun includeRows(counts: AskCounts, selection: AskSelection): List<IncludeRow> =
	Include.entries.mapNotNull { include ->
		val count = when (include) {
			Include.NOT_RECORDED -> counts.notRecorded
			Include.WEAK -> counts.weak
			Include.ASKED -> counts.asked
			Include.LOCALS -> counts.locals ?: return@mapNotNull null
		}
		IncludeRow(include, includeLabel(include), count, include in selection.include)
	}

private fun includeLabel(include: Include): String =
	when (include) {
		Include.NOT_RECORDED -> "Not recorded"
		Include.WEAK -> "Stale, doubted or thin"
		Include.ASKED -> "Already asked"
		Include.LOCALS -> "Parameters and locals"
	}

/**
 * What the sheet draws from one read: its counts, the order it would ask in, and what refuses a send.
 * `pairs` is the set the owner reviewed, which the send is refused against.
 */
internal data class AskOffer(
	val counts: AskCounts,
	val order: String?,
	val pairs: Set<AskedKey>,
	val tooLarge: Int?,
)

internal fun askOffer(
	members: WorkspaceKnowledgeScopeAnswer?,
	file: WorkspaceKnowledgeScopeAnswer?,
	selected: WorkspaceKnowledgeScopeAnswer?,
	subject: AskSubject,
	selection: AskSelection,
	asked: AskedLookup,
): AskOffer {
	val picked = selected?.let { picks(scopeSymbols(it, subject, selection.scope), selection, asked) }.orEmpty()
	return AskOffer(
		counts = askCounts(members, file, selected, subject, selection, asked),
		order = orderLine(picked),
		pairs = selected?.let { askedPairs(subject.target.address, it, picked).keys }.orEmpty(),
		tooLarge = if (picked.isEmpty() || selected == null) {
			null
		} else {
			overBudget(askMessage(subject, selection.scope, selected, picked))
		},
	)
}

internal fun offerText(offer: AskOffer): String = offer.tooLarge?.let(::tooLargeSendText) ?: summaryText(offer.counts)

internal fun canSend(offer: AskOffer, sending: Boolean): Boolean =
	!sending && offer.tooLarge == null && offer.counts.answers > 0

internal fun tooLargeSendText(bytes: Int): String = "Too large to send · ${prettySize(bytes.toLong())}"

/**
 * What a send did, in what the sheet does about it. A send that read again landed that read on the
 * sheet's own showing, so a moved root or a grown scope redraws its counts without being told to.
 */
internal sealed interface AskOutcome {
	data object Close : AskOutcome

	data class Said(val notice: String) : AskOutcome

	data class NotRead(val state: FacetState<Nothing>) : AskOutcome
}

internal fun askOutcome(sent: AskSent): AskOutcome =
	when (sent) {
		is AskSent.Sent, is AskSent.Unknown -> AskOutcome.Close
		AskSent.AlreadySending -> AskOutcome.Said("Already asking")
		AskSent.Failed -> AskOutcome.Said("That did not leave the phone")
		AskSent.NothingToAsk -> AskOutcome.Said("Nothing to ask")
		is AskSent.TooLarge -> AskOutcome.Said(tooLargeSendText(sent.bytes))
		AskSent.RootChanged -> AskOutcome.Said("This workspace moved")
		AskSent.Changed -> AskOutcome.Said("Changed since you looked")
		is AskSent.NotRead -> AskOutcome.NotRead(sent.state)
	}

internal fun <T> toggled(set: Set<T>, value: T): Set<T> = if (value in set) set - value else set + value
