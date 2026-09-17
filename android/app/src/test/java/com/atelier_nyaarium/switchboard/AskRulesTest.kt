package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeEntry
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeQuestion
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeSymbol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ADDRESS = "home.sakura.host.aaa"

private const val ROOT = "/work/repo"

private const val MODULE = "src/localAgentSession.ts"

private const val ROOT_ID = "lexicon typescript src/localAgentSession.ts LocalBackendSession"

private val MEMBER_NAMES =
	listOf("openThread", "startTurn", "steerTurn", "interruptTurn", "onActivity", "onClosed", "close")

private fun question(
	name: String,
	createdAt: Double? = null,
	stale: Boolean? = null,
	shaky: Boolean? = null,
	thin: Boolean? = null,
	doubted: Boolean? = null,
) = WorkspaceScopeQuestion(
	question = name,
	createdAt = createdAt,
	thin = thin,
	stale = stale,
	shaky = shaky,
	doubted = doubted,
	askCount = 0,
)

private fun symbol(
	id: String,
	name: String,
	kind: String,
	depth: Long,
	container: String? = null,
	questions: List<WorkspaceScopeQuestion> = QUESTION_CLASSES.map { question(it) },
) = WorkspaceScopeSymbol(
	symbolId = id,
	name = name,
	symbolKind = kind,
	depth = depth,
	startLine = 1,
	containerId = container,
	questions = questions,
)

private fun memberId(name: String) = "$ROOT_ID.$name"

class AskRulesTest {
	private val target = WorkspaceTarget(gatewayId = "sakura", address = ADDRESS)
	private val subject = AskSubject(target, ROOT_ID, "LocalBackendSession", MODULE)
	private val none = AskedLookup { _, _ -> false }

	private val rootSymbol = symbol(ROOT_ID, "LocalBackendSession", "class", 0)

	/** Post-order, as Lexicon walks it: members, then the declaration holding them. */
	private val members = WorkspaceKnowledgeScopeAnswer(
		root = ROOT,
		module = MODULE,
		symbols = MEMBER_NAMES.map { symbol(memberId(it), it, "method", 1, ROOT_ID) } + rootSymbol,
		localsExcluded = 18,
	)

	private val file = WorkspaceKnowledgeScopeAnswer(
		root = ROOT,
		module = MODULE,
		symbols = members.symbols + (1..7).map { symbol("$ROOT_ID$it", "other$it", "function", 0) },
		localsExcluded = 30,
	)

	private fun countsFor(selection: AskSelection, asked: AskedLookup = none): AskCounts {
		val selected = if (selection.scope == AskScope.FILE) file else members
		return askCounts(members, file, selected, subject, selection, asked)
	}

	@Test
	fun `the header's Ask selects every question and an unrecorded row only its own`() {
		assertEquals("6 answers across 1 symbol", summaryText(countsFor(defaultSelection(null))))
		assertEquals("1 answer across 1 symbol", summaryText(countsFor(defaultSelection("describe"))))
		assertEquals(
			listOf("describe"),
			picks(listOf(rootSymbol), defaultSelection("describe"), none).single().questions,
		)
	}

	@Test
	fun `defaults take not recorded and stale, doubted or thin, and leave out asked and locals`() {
		val mixed = symbol(
			ROOT_ID,
			"LocalBackendSession",
			"class",
			0,
			questions = listOf(
				question("describe"),
				question("why", createdAt = 4.0, stale = true),
				question("relate", createdAt = 4.0),
			),
		)

		assertEquals(listOf("describe", "why"), picks(listOf(mixed), defaultSelection(null), none).single().questions)
		assertNull(countsFor(defaultSelection(null)).locals)
	}

	@Test
	fun `a changed root resets the selection and a first root only stamps it`() {
		val picked = defaultSelection(null).copy(scope = AskScope.FILE, include = setOf(Include.ASKED, Include.LOCALS))

		val stamped = selectionForRoot(picked, ROOT)
		assertEquals(picked.copy(root = ROOT), stamped)
		assertEquals(stamped, selectionForRoot(stamped, ROOT))

		val moved = selectionForRoot(stamped, "/work/other")
		assertEquals(defaultSelection(null).copy(root = "/work/other"), moved)
	}

	@Test
	fun `scope notes count one symbol, the symbol with its members, and the file`() {
		val counts = countsFor(defaultSelection(null))
		assertEquals(mapOf(AskScope.SYMBOL to 1, AskScope.MEMBERS to 8, AskScope.FILE to 15), counts.scopeSymbols)

		val unread = askCounts(null, null, null, subject, defaultSelection(null), none)
		assertEquals(mapOf(AskScope.SYMBOL to null, AskScope.MEMBERS to null, AskScope.FILE to null), unread.scopeSymbols)
		assertEquals("Nothing to ask", summaryText(unread))
	}

	@Test
	fun `a chip counts its question's pairs that pass the includes, whichever questions are ticked`() {
		val counts = countsFor(fillSelection)

		assertEquals(QUESTION_CLASSES.associateWith { 8 }, counts.perQuestion)

		val recorded = countsFor(fillSelection.copy(include = setOf(Include.WEAK)))
		assertEquals(emptyMap<String, Int>(), recorded.perQuestion)
	}

	@Test
	fun `include rows count ticked questions' pairs, and locals the scope's excluded declarations`() {
		val counts = countsFor(fillSelection)

		assertEquals(16, counts.notRecorded)
		assertEquals(0, counts.weak)
		assertEquals(0, counts.asked)
		assertEquals(18, counts.locals)
		assertEquals("16 answers across 8 symbols", summaryText(counts))
		assertEquals(30, countsFor(fillSelection.copy(scope = AskScope.FILE)).locals)
	}

	@Test
	fun `a recorded healthy answer is never picked`() {
		val healthy = symbol(ROOT_ID, "f", "function", 0, questions = listOf(question("describe", createdAt = 4.0)))
		val everything = defaultSelection(null).copy(
			include = setOf(Include.NOT_RECORDED, Include.WEAK, Include.ASKED, Include.LOCALS),
		)

		assertEquals(emptyList<AskPick>(), picks(listOf(healthy), everything, none))
	}

	@Test
	fun `a shaky answer counts as stale, doubted or thin`() {
		val shaky = symbol(ROOT_ID, "f", "function", 0, questions = listOf(question("why", createdAt = 4.0, shaky = true)))
		val selection = defaultSelection(null)

		assertEquals(listOf("why"), picks(listOf(shaky), selection, none).single().questions)
		assertEquals(emptyList<AskPick>(), picks(listOf(shaky), selection.copy(include = setOf(Include.NOT_RECORDED)), none))
		assertEquals(1, askCounts(null, null, shakyAnswer(shaky), subject, selection, none).weak)
	}

	@Test
	fun `an asked pair is left out unless Already asked is ticked`() {
		val asked = AskedLookup { _, name -> name == "describe" }
		val selection = defaultSelection(null)

		assertEquals(
			QUESTION_CLASSES - "describe",
			picks(listOf(rootSymbol), selection, asked).single().questions,
		)
		assertEquals(
			QUESTION_CLASSES,
			picks(listOf(rootSymbol), selection.copy(include = selection.include + Include.ASKED), asked).single().questions,
		)
		assertEquals(6, countsFor(selection, asked).notRecorded)
		assertEquals(6, countsFor(selection, AskedLookup { _, _ -> true }).asked)
	}

	@Test
	fun `picks run members before the declaration holding them`() {
		val picked = picks(members.symbols, fillSelection, none)

		assertEquals(MEMBER_NAMES + "LocalBackendSession", picked.map { it.symbol.name })
		assertEquals("openThread › startTurn › steerTurn › … › close › LocalBackendSession", orderLine(picked))
		assertNull(orderLine(picks(listOf(rootSymbol), defaultSelection(null), none)))
	}

	@Test
	fun `the message gives intent, then how, then a tree nesting members under their container with whole ids`() {
		val answer = WorkspaceKnowledgeScopeAnswer(
			root = ROOT,
			module = MODULE,
			symbols = listOf(
				symbol(memberId("close"), "close", "method", 1, ROOT_ID, listOf(question("describe"))),
				symbol(ROOT_ID, "LocalBackendSession", "class", 0, null, listOf(question("describe"))),
			),
			localsExcluded = 0,
		)
		val text = askMessage(subject, AskScope.MEMBERS, answer, picks(answer.symbols, defaultSelection(null), none))
		val lines = text.split("\n")

		assertEquals(
			"Record Lexicon knowledge for `LocalBackendSession` and its members in `$MODULE`: " +
				"2 answers across 2 symbols. I chose this set on my phone, so record every one without asking me first.",
			lines.first(),
		)
		assertEquals("How:", lines[2])
		assertTrue(lines[3].startsWith("- For each symbol, call `symbol_facts`"))
		assertEquals("Tree:", lines[lines.size - 3])
		assertEquals("- `LocalBackendSession` class: describe. `$ROOT_ID`", lines[lines.size - 2])
		assertEquals("  - `close` method: describe. `${memberId("close")}`", lines.last())
	}

	@Test
	fun `a whole-file message has one branch per top-level symbol, and a container with nothing picked still holds its members`() {
		val answer = WorkspaceKnowledgeScopeAnswer(
			root = ROOT,
			module = MODULE,
			symbols = listOf(
				symbol("$ROOT_ID.a1", "a1", "method", 1, "$ROOT_ID.A", listOf(question("describe"))),
				symbol("$ROOT_ID.A", "A", "class", 0, null, listOf(question("describe", createdAt = 4.0))),
				symbol("$ROOT_ID.B", "B", "function", 0, null, listOf(question("describe"))),
			),
			localsExcluded = 0,
		)
		val text = askMessage(subject, AskScope.FILE, answer, picks(answer.symbols, defaultSelection(null), none))

		assertTrue(text.startsWith("Record Lexicon knowledge for every declaration in `$MODULE`: 2 answers across 2 symbols."))
		assertEquals(
			listOf(
				"- `A` class: nothing to record here. `$ROOT_ID.A`",
				"  - `a1` method: describe. `$ROOT_ID.a1`",
				"- `B` function: describe. `$ROOT_ID.B`",
			),
			text.split("\n").takeLast(3),
		)
	}

	@Test
	fun `a name holding a backtick keeps its code span whole`() {
		assertEquals("`plain`", codeSpan("plain"))
		assertEquals("``a`b``", codeSpan("a`b"))
		assertEquals("`` id` ``", codeSpan("id`"))
		assertEquals("`` `lead ``", codeSpan("`lead"))

		val odd = symbol("id`", "a```b", "function", 0, null, listOf(question("describe")))
		val answer = WorkspaceKnowledgeScopeAnswer(root = ROOT, module = MODULE, symbols = listOf(odd), localsExcluded = 0)

		val line = askMessage(subject, AskScope.FILE, answer, picks(answer.symbols, defaultSelection(null), none)).split("\n").last()

		assertEquals("- ````a```b```` function: describe. `` id` ``", line)
	}

	@Test
	fun `a message at the budget sends and one byte over is refused with its size`() {
		assertNull(overBudget("x".repeat(ASK_MESSAGE_BUDGET_BYTES)))
		assertEquals(ASK_MESSAGE_BUDGET_BYTES + 1, overBudget("x".repeat(ASK_MESSAGE_BUDGET_BYTES + 1)))

		val twoByte = Char(0x00e9).toString().repeat(ASK_MESSAGE_BUDGET_BYTES / 2 + 1)
		assertEquals(ASK_MESSAGE_BUDGET_BYTES + 2, overBudget(twoByte))
	}

	@Test
	fun `progress reads the age for one symbol and recorded over sent for a wider send`() {
		val threeMinutes = 3 * 60_000L
		val single = send(QUESTION_CLASSES.map { keyOf(ROOT_ID, it) }, recorded = 2)
		val single3 = progressOf(single, members, threeMinutes)!!

		assertEquals("Asked 3 min ago", progressText(single3, threeMinutes))
		assertEquals(1, single3.rows.size)
		assertEquals(4, single3.rows.single().out)

		val wide = send(
			MEMBER_NAMES.flatMap { name -> listOf("describe", "contract").map { keyOf(memberId(name), it) } } +
				listOf("describe", "contract").map { keyOf(ROOT_ID, it) },
			recorded = 6,
		)
		val spread = progressOf(wide, members, threeMinutes)!!

		assertEquals("6 of 16 recorded", progressText(spread, threeMinutes))
		assertEquals(MEMBER_NAMES + "LocalBackendSession", spread.rows.map { it.name })
		assertEquals(listOf("describe", "contract"), spread.rows.first().recorded)

		assertNull(progressOf(send(listOf(keyOf(ROOT_ID, "why")), recorded = 1), members, threeMinutes))
		assertNull(progressOf(single, members, ASKED_TTL_MS))
		assertNull(progressOf(null, members, threeMinutes))
	}

	@Test
	fun `a question row reads recorded, asked or not recorded`() {
		assertEquals(RowWord.RECORDED, rowWord(question("why", createdAt = 4.0), null, true))
		assertEquals(RowWord.RECORDED, rowWord(null, "it answers", false))
		assertEquals(RowWord.ASKED, rowWord(question("why"), null, true))
		assertEquals(RowWord.NOT_RECORDED, rowWord(null, null, false))

		assertEquals("0 of 6 recorded", recordedText(QUESTION_CLASSES.map { question(it) }, null))
		assertEquals(
			"2 of 6 recorded",
			recordedText(QUESTION_CLASSES.mapIndexed { at, it -> question(it, createdAt = if (at < 2) 4.0 else null) }, null),
		)
		assertEquals(
			"2 of 6 recorded",
			recordedText(null, listOf(WorkspaceKnowledgeEntry("why", "a"), WorkspaceKnowledgeEntry("usage", "b"))),
		)
		assertEquals("0 of 6 recorded", recordedText(null, null))
	}

	@Test
	fun `a scope names where it is read and what its request is`() {
		assertEquals(WorkspaceKnowledgeScopeTarget.Members(ROOT_ID), readTarget(subject, AskScope.SYMBOL))
		assertEquals(WorkspaceKnowledgeScopeTarget.Members(ROOT_ID), readTarget(subject, AskScope.MEMBERS))
		assertEquals(WorkspaceKnowledgeScopeTarget.File(MODULE), readTarget(subject, AskScope.FILE))

		val key = requestKey(subject, ROOT, AskScope.MEMBERS)
		assertEquals(RequestKind.KNOWLEDGE, key.kind)
		assertEquals(ADDRESS, key.address)
		assertNotEquals(key.subject, requestKey(subject, ROOT, AskScope.SYMBOL).subject)
		assertNotEquals(key.subject, requestKey(subject, "/work/other", AskScope.MEMBERS).subject)
	}

	@Test
	fun `the page keeps the scope of the newest send made from this subject`() {
		val wide = send(listOf(keyOf(ROOT_ID, "why")), 0).copy(id = 4, scopeSubject = scopeSubject(subject, AskScope.FILE))
		val narrow = send(listOf(keyOf(ROOT_ID, "why")), 0).copy(id = 7, scopeSubject = scopeSubject(subject, AskScope.SYMBOL))
		val held = listOf(wide, narrow).associateBy { it.scopeSubject }

		assertEquals(AskScope.MEMBERS, pageScope(subject, null))
		assertEquals(AskScope.FILE, pageScope(subject, pageSend(subject) { if (it == wide.scopeSubject) wide else null }))
		// One symbol and its members share a read, so the newer narrow send leaves the page on Members.
		assertEquals(AskScope.MEMBERS, pageScope(subject, pageSend(subject) { held[it] }))
	}

	@Test
	fun `a question row reads recorded, asked or not recorded, and only an open one is tapped`() {
		val entry = symbol(
			ROOT_ID,
			"LocalBackendSession",
			"class",
			0,
			questions = listOf(question("describe", createdAt = 4.0), question("why"), question("relate")),
		)
		val rows = askRows(
			listOf(
				KnowledgeRow("describe", "It opens threads.", emptyList()),
				KnowledgeRow("why", null, emptyList()),
				KnowledgeRow("relate", null, emptyList()),
			),
			ROOT_ID,
			entry,
			AskedLookup { _, question -> question == "why" },
		)

		assertEquals(listOf(RowWord.RECORDED, RowWord.ASKED, RowWord.NOT_RECORDED), rows.map { it.word })
		assertEquals(listOf("recorded", "asked", "not recorded"), rows.map { rowWordText(it.word) })
	}

	@Test
	fun `a progress row reads what it recorded, or the one word for a row nothing came back on`() {
		assertEquals(
			ProgressLine("describe, contract", RowWord.RECORDED),
			progressLine(ProgressRow(ROOT_ID, "close", listOf("describe", "contract"), 4)),
		)
		assertEquals(ProgressLine("asked", RowWord.ASKED), progressLine(ProgressRow(ROOT_ID, "close", emptyList(), 6)))
	}

	@Test
	fun `a chip counts its question only where the scope holds more than one symbol`() {
		val wide = questionChips(countsFor(fillSelection), fillSelection)
		val narrow = questionChips(countsFor(defaultSelection(null)), defaultSelection(null))

		assertEquals("Describe 8", wide.first().label)
		assertEquals(listOf(true, false, false, true, false, false), wide.map { it.on })
		assertEquals("Describe", narrow.first().label)
	}

	@Test
	fun `the include rows carry the ticked questions' counts, and locals only where a scope excludes some`() {
		val rows = includeRows(countsFor(fillSelection), fillSelection)

		assertEquals(listOf(16, 0, 0, 18), rows.map { it.count })
		assertEquals(listOf(true, true, false, false), rows.map { it.on })
		assertEquals(3, includeRows(countsFor(defaultSelection(null)), defaultSelection(null)).size)
	}

	@Test
	fun `an offer sends what it counts, and a message over the budget refuses with its size`() {
		val offer = askOffer(members, file, members, subject, fillSelection, none)

		assertEquals("16 answers across 8 symbols", offerText(offer))
		assertTrue(canSend(offer, sending = false))
		assertTrue(!canSend(offer, sending = true))

		val huge = (1..3_000).map { symbol("$ROOT_ID ${"declaration".repeat(4)}$it", "d$it", "constant", 0) }
		val over = askOffer(
			members,
			file,
			WorkspaceKnowledgeScopeAnswer(root = ROOT, module = MODULE, symbols = huge, localsExcluded = 0),
			subject,
			fillSelection.copy(scope = AskScope.FILE),
			none,
		)

		assertTrue(offerText(over).startsWith("Too large to send · "))
		assertTrue(!canSend(over, sending = false))
	}

	@Test
	fun `a send that landed closes the sheet, a lost one says so, and a refused read is drawn`() {
		assertEquals(AskOutcome.Close, askOutcome(AskSent.Sent(6)))
		assertEquals(AskOutcome.Close, askOutcome(AskSent.Unknown(6)))
		assertEquals(AskOutcome.Said("That did not leave the phone"), askOutcome(AskSent.Failed))
		assertEquals(AskOutcome.Said("Already asking"), askOutcome(AskSent.AlreadySending))
		assertEquals(AskOutcome.Said("Nothing to ask"), askOutcome(AskSent.NothingToAsk))
		assertTrue(askOutcome(AskSent.NotRead(FacetState.Unreachable)) is AskOutcome.NotRead)
	}

	private val fillSelection = defaultSelection(null).copy(
		scope = AskScope.MEMBERS,
		questions = setOf("describe", "contract"),
		root = ROOT,
	)

	private fun shakyAnswer(only: WorkspaceScopeSymbol) =
		WorkspaceKnowledgeScopeAnswer(root = ROOT, module = MODULE, symbols = listOf(only), localsExcluded = 0)

	private fun keyOf(symbolId: String, question: String) = AskedKey(ADDRESS, ROOT, symbolId, question)

	private fun send(keys: List<AskedKey>, recorded: Int) =
		AskSend(
			id = 1,
			sentAt = 0,
			address = ADDRESS,
			root = ROOT,
			scopeSubject = "MEMBERS",
			pairs = keys.associateWith { null },
			recorded = keys.take(recorded).toSet(),
		)
}
