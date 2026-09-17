package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetComment
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUnboundType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeCounts
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeFacts
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_800_000_000_000L

private const val DAY_MS = 86_400_000L

class FacetRulesTest {
	////////////////////////////////
	//  Builders

	private fun symbol(name: String, module: String = "src/a.ts", kind: String = "class", startLine: Long? = 10) =
		WorkspaceFacetSymbol(symbolId = "$module#$name", name = name, symbolKind = kind, module = module, startLine = startLine)

	private fun use(
		module: String = "src/a.ts",
		line: Long = 20,
		role: String = "call",
		holder: WorkspaceFacetSymbol? = null,
		topLevel: WorkspaceFacetSymbol? = null,
		startColumn: Long = 4,
		name: String = "Target",
	) = WorkspaceFacetUse(
		module = module,
		line = line,
		startColumn = startColumn,
		endColumn = startColumn + name.length,
		name = name,
		role = role,
		holder = holder,
		topLevel = topLevel,
	)

	private fun counts(
		uses: Long = 0,
		useFiles: Long = 0,
		dependents: Long = 0,
		dependentFiles: Long = 0,
		targets: Long = 0,
		boundTargets: Long = 0,
		references: Long = 0,
		members: Long = 0,
		supertypes: Long = 0,
		subtypes: Long = 0,
		comments: Long = 0,
	) = WorkspaceKnowledgeCounts(
		uses = uses,
		useFiles = useFiles,
		dependents = dependents,
		dependentFiles = dependentFiles,
		targets = targets,
		boundTargets = boundTargets,
		references = references,
		members = members,
		supertypes = supertypes,
		subtypes = subtypes,
		comments = comments,
	)

	private fun knowledge(kind: String?, counted: WorkspaceKnowledgeCounts?) =
		WorkspaceKnowledgeAnswer(
			symbolId = "src/a.ts#Sub",
			symbolKind = kind,
			facts = WorkspaceKnowledgeFacts(
				members = 7,
				references = 13,
				fanIn = 8,
				fanOut = 2,
				supertypes = 1,
				subtypes = 3,
				comments = 5,
				counts = counted,
			),
		)

	private fun valueOf(rows: List<FactRow>, entry: FacetEntry): String = rows.single { it.entry == entry }.value

	private fun opensOf(rows: List<FactRow>, entry: FacetEntry): Boolean = rows.single { it.entry == entry }.opens

	private fun listed(symbolId: String, facet: WorkspaceFacetAnswer) =
		WorkspaceAnswer.Read(WorkspaceListing.Listed(WorkspaceSymbolFacetAnswer(symbolId = symbolId, facet = facet)))

	private fun headers(items: List<UseItem>) = items.filterIsInstance<UseItem.Header>()

	private fun rows(items: List<UseItem>) = items.filterIsInstance<UseItem.Row>()

	////////////////////////////////
	//  Uses

	private val handlers = symbol("LocalAgentHandlers", "src/mcp/local/localAgentHandlers.ts", startLine = 61)

	private val child = symbol("LocalChildSession", "src/mcp/local/localChildSession.ts", startLine = 15)

	private val start = symbol("start", "src/mcp/local/localAgentHandlers.ts", "method", 93)

	private val session = symbol("session", "src/mcp/local/localChildSession.ts", "method", 16)

	private val thirteen = listOf(
		use("src/mcp/local/localAgentHandlers.ts", 99, "typeUse", start, handlers),
		use("src/mcp/local/localAgentHandlers.ts", 101, "call", handlers, handlers),
		use("src/mcp/local/localAgentHandlers.ts", 104, "implements", start, handlers),
		use("src/mcp/local/localAgentHandlers.ts", 61, "typeUse", handlers, handlers),
		use("src/mcp/local/localChildSession.ts", 16, "typeUse", session, child),
		use("src/mcp/local/localChildSession.ts", 18, "implements", session, child),
		use("src/mcp/local/localChildSession.ts", 4, "typeUse"),
	)

	@Test
	fun `references open By file and Used by opens By symbol`() {
		assertEquals(UseGrouping.BY_FILE, initialGrouping(FacetEntry.REFERENCES))
		assertEquals(UseGrouping.BY_SYMBOL, initialGrouping(FacetEntry.USED_BY))
	}

	@Test
	fun `By symbol groups under each top-level declaration, most uses first, with a module-level use under its file`() {
		val items = useItems(thirteen, UseGrouping.BY_SYMBOL, null)
		assertEquals(
			listOf("LocalAgentHandlers" to 4, "LocalChildSession" to 2, "src/mcp/local/localChildSession.ts" to 1),
			headers(items).map { it.title to it.count },
		)
		val loose = headers(items).last()
		assertNull(loose.kind)
		assertNull(loose.opens)
		assertEquals("file level", rows(items).single { it.line == 4L }.label)
		assertEquals("declaration", rows(items).single { it.line == 61L }.label)
		assertEquals("body", rows(items).single { it.line == 101L }.label)
		assertEquals("start", rows(items).single { it.line == 99L }.label)
	}

	@Test
	fun `By file groups files in path order and lists uses in line order`() {
		val items = useItems(thirteen, UseGrouping.BY_FILE, null)
		assertEquals(
			listOf("src/mcp/local/localAgentHandlers.ts", "src/mcp/local/localChildSession.ts"),
			headers(items).map { it.title },
		)
		assertTrue(headers(items).all { it.opens == null })
		// A path is not a declaration, so it is drawn as written.
		assertTrue(headers(items).none { it.declaration })
		assertTrue(headers(useItems(thirteen, UseGrouping.BY_SYMBOL, null)).any { it.declaration })
		assertEquals(listOf(61L, 99L, 101L, 104L, 4L, 16L, 18L), rows(items).map { it.line })
		assertEquals("LocalChildSession.session", rows(items).single { it.line == 16L }.label)
		assertEquals("LocalAgentHandlers", rows(items).single { it.line == 61L }.label)
	}

	@Test
	fun `a role chip counts its role over every use, All counts them all, and a single role draws no chips`() {
		assertEquals(
			listOf(null to 7, "typeUse" to 4, "implements" to 2, "call" to 1),
			roleChips(thirteen).map { it.role to it.count },
		)
		assertEquals("Implements", roleChips(thirteen).single { it.role == "implements" }.label)
		assertEquals(RoleTone.HERITAGE, roleTone("implements"))
		assertEquals(RoleTone.PLAIN, roleTone("call"))
		assertEquals(emptyList<RoleChip>(), roleChips(thirteen.filter { it.role == "call" }))
	}

	@Test
	fun `a role the answer leaves blank is still labelled, and keeps the raw role as its filter`() {
		val blank = thirteen.map { it.copy(role = "") }
		val chip = roleChips(blank + thirteen.first()).single { it.role == "" }

		assertTrue(chip.label.isNotBlank())
		assertEquals(roleLabel(""), chip.label)
		assertTrue(rows(useItems(blank, UseGrouping.BY_SYMBOL, null)).all { it.role.isNotBlank() })
		// The raw role filters, so a labelled chip still selects the rows it counted.
		assertEquals(blank.size, rows(useItems(blank + thirteen.first(), UseGrouping.BY_SYMBOL, "")).size)
	}

	@Test
	fun `a chip leaves only its role's rows and drops groups it empties`() {
		val items = useItems(thirteen, UseGrouping.BY_SYMBOL, "implements")
		assertEquals(listOf("LocalAgentHandlers" to 1, "LocalChildSession" to 1), headers(items).map { it.title to it.count })
		assertTrue(rows(items).all { it.role == "Implements" })
	}

	@Test
	fun `every key is unique, even for two uses at one position`() {
		val twice = listOf(use(line = 20, holder = start, topLevel = handlers), use(line = 20, holder = start, topLevel = handlers))
		val items = useItems(thirteen + twice, UseGrouping.BY_SYMBOL, null)
		assertEquals(items.size, items.map { it.key }.distinct().size)
	}

	@Test
	fun `a row whose own key reads as another's second mint still gets its own`() {
		val twice = listOf(use(line = 20, holder = start, topLevel = handlers), use(line = 20, holder = start, topLevel = handlers))
		val suffixed = use(line = 20, role = "call:2", holder = start, topLevel = handlers)
		val items = useItems(twice + suffixed, UseGrouping.BY_SYMBOL, null)
		assertEquals(items.size, items.map { it.key }.distinct().size)
	}

	@Test
	fun `a use opens the declaration it sits in at its line, a header its top-level symbol, and a module-level use nothing`() {
		val items = useItems(thirteen, UseGrouping.BY_SYMBOL, null)
		val body = rows(items).single { it.line == 99L }
		assertEquals(start.symbolId, body.opens!!.symbolId)
		assertEquals(Reached("Target", "Type", 99), body.opens.reached)

		val header = headers(items).first()
		assertEquals(handlers.symbolId, header.opens!!.symbolId)
		assertNull(header.opens.reached)

		assertNull(rows(items).single { it.line == 4L }.opens)
	}

	@Test
	fun `uses from lists bound targets first, then ambiguous, then names outside the index, and only bound ones open`() {
		val bound = WorkspaceFacetTarget(
			name = "CodexServiceTier",
			status = "bound",
			target = symbol("CodexServiceTier", "src/shared/codexAgentIdentity.ts", "interface", 122),
			uses = listOf(use(line = 28, holder = start, topLevel = handlers), use(line = 33, holder = start, topLevel = handlers)),
		)
		val vague = WorkspaceFacetTarget(name = "Handle", status = "ambiguous", uses = listOf(use(line = 40)))
		val outside = WorkspaceFacetTarget(
			name = "Promise",
			status = "unbound",
			reason = "ExternalDependency",
			uses = listOf(use(line = 41), use(line = 42), use(line = 43)),
		)
		val items = targetItems(listOf(outside, vague, bound))

		assertEquals(listOf("CodexServiceTier", "Handle", "Promise"), headers(items).map { it.title })
		assertEquals(listOf(null, "ambiguous", "not indexed"), headers(items).map { it.outside })
		assertNotNull(headers(items).first().opens)
		assertTrue(headers(items).drop(1).all { it.opens == null })
		assertEquals("1 symbol, and 1 name outside the index", targetsSubtitle(listOf(bound, outside)))
		assertEquals("1 symbol, 1 ambiguous, and 1 name outside the index", targetsSubtitle(listOf(bound, vague, outside)))
	}

	@Test
	fun `a listing's subtitle counts its uses, symbols and files`() {
		assertEquals("7 uses in 2 symbols, 2 files", usesSubtitle(thirteen))
		assertEquals("1 use in 1 symbol, 1 file", usesSubtitle(thirteen.take(1)))
		assertEquals("none", usesSubtitle(emptyList()))
	}

	////////////////////////////////
	//  Facts

	@Test
	fun `fact rows carry their units and read none at zero, and a zero row does not open`() {
		val full = factRows(
			knowledge(
				"interface",
				counts(
					uses = 13, useFiles = 7, dependents = 8, dependentFiles = 1, targets = 3, boundTargets = 2,
					members = 7, subtypes = 3, comments = 5,
				),
			),
			null,
			NOW,
		) as FactRows.Counted
		assertEquals(
			listOf(
				FacetEntry.MEMBERS, FacetEntry.REFERENCES, FacetEntry.USED_BY, FacetEntry.USES,
				FacetEntry.HIERARCHY, FacetEntry.COMMENTS, FacetEntry.HISTORY,
			),
			full.rows.map { it.entry },
		)
		assertEquals("7", valueOf(full.rows, FacetEntry.MEMBERS))
		assertEquals("13 uses in 7 files", valueOf(full.rows, FacetEntry.REFERENCES))
		assertEquals("8 symbols, 1 file", valueOf(full.rows, FacetEntry.USED_BY))
		assertEquals("2 symbols", valueOf(full.rows, FacetEntry.USES))
		assertEquals("5", valueOf(full.rows, FacetEntry.COMMENTS))
		assertTrue(full.rows.filter { it.entry != FacetEntry.HISTORY }.all { it.opens })

		val empty = factRows(knowledge("interface", counts(uses = 1, useFiles = 1)), null, NOW) as FactRows.Counted
		assertEquals("none", valueOf(empty.rows, FacetEntry.MEMBERS))
		assertEquals("1 use", valueOf(empty.rows, FacetEntry.REFERENCES))
		assertEquals("none", valueOf(empty.rows, FacetEntry.USED_BY))
		assertEquals("none", valueOf(empty.rows, FacetEntry.USES))
		assertEquals("none", valueOf(empty.rows, FacetEntry.HIERARCHY))
		assertFalse(opensOf(empty.rows, FacetEntry.MEMBERS))
		assertTrue(opensOf(empty.rows, FacetEntry.REFERENCES))
	}

	@Test
	fun `a declaration that is not a type reads not a type`() {
		val rows = factRows(knowledge("method", counts(supertypes = 1, subtypes = 2)), null, NOW) as FactRows.Counted
		assertEquals("not a type", valueOf(rows.rows, FacetEntry.HIERARCHY))
		assertFalse(opensOf(rows.rows, FacetEntry.HIERARCHY))
	}

	@Test
	fun `an interface's subtypes read as implementations`() {
		val implementing = factRows(knowledge("interface", counts(subtypes = 3)), null, NOW) as FactRows.Counted
		assertEquals("3 implementations", valueOf(implementing.rows, FacetEntry.HIERARCHY))

		val descending = factRows(knowledge("class", counts(supertypes = 1, subtypes = 1)), null, NOW) as FactRows.Counted
		assertEquals("1 supertype, 1 subtype", valueOf(descending.rows, FacetEntry.HIERARCHY))
	}

	@Test
	fun `facts from an older plugin keep their numbers, read none at zero, and open nothing`() {
		val legacy = factRows(knowledge("interface", null), null, NOW) as FactRows.Legacy
		assertEquals(listOf("7", "13", "8", "2", "4"), legacy.rows.map { it.value })
		assertTrue(legacy.rows.none { it.opens })
		assertTrue(legacy.rows.none { it.entry == FacetEntry.HISTORY })
		assertNull(factRows(WorkspaceKnowledgeAnswer(symbolId = "s"), null, NOW))

		val nothing = WorkspaceKnowledgeFacts(
			members = 0,
			references = 0,
			fanIn = 0,
			fanOut = 0,
			supertypes = 0,
			subtypes = 0,
			comments = 0,
		)
		val empty = factRows(WorkspaceKnowledgeAnswer(symbolId = "s", facts = nothing), null, NOW) as FactRows.Legacy
		val counted = factRows(knowledge("interface", counts()), null, NOW) as FactRows.Counted
		assertTrue(empty.rows.all { it.value == valueOf(counted.rows, FacetEntry.MEMBERS) })
	}

	@Test
	fun `last changed reads the newest commit's age, and untracked, outside git and never committed each dim`() {
		fun changed(state: FacetState<WorkspaceFacetAnswer>?) =
			(factRows(knowledge("class", counts()), state, NOW) as FactRows.Counted).rows.single { it.entry == FacetEntry.HISTORY }

		val commits = history(
			"commits",
			listOf(commit("4b54a28", NOW - 12 * DAY_MS), commit("0ab0bd6", NOW - 28 * DAY_MS)),
		)
		assertEquals("12 days ago" to true, changed(FacetState.Shown(commits)).let { it.value to it.opens })
		assertEquals("untracked", changed(FacetState.Shown(history("untracked", emptyList()))).value)
		assertEquals("not in git", changed(FacetState.Shown(history("notRepository", emptyList()))).value)
		assertEquals("none", changed(FacetState.Shown(history("none", emptyList()))).value)
		assertEquals("unavailable", changed(FacetState.Unreachable).value)
		assertFalse(changed(null).opens)
	}

	////////////////////////////////
	//  Facet states

	@Test
	fun `an oversized listing names its rows in the facet's unit and its size, and without a size its rows are a floor`() {
		val sized = facetState(FacetEntry.REFERENCES, "s", WorkspaceAnswer.Read(WorkspaceListing.TooLarge(48_213, 4_213_377)))
		assertEquals("48,213 uses · 4.2 MB", (sized as FacetState.TooLarge).text)

		val floor = facetState(FacetEntry.USES, "s", WorkspaceAnswer.Read(WorkspaceListing.TooLarge(100_000, null)))
		assertEquals("100,000+ references", (floor as FacetState.TooLarge).text)
	}

	@Test
	fun `a refusal naming an update, from the plugin, Lexicon or the Gateway, draws the update notice, and any other draws its reason`() {
		val plugin = refusalOf("this session's plugin cannot read that workspace op; update it")
		val lexicon = refusalOf("this workspace op needs a newer index; update the lexicon plugin")
		val gateway = refusalOf("""[{"code":"invalid_union","path":["op"],"message":"Invalid input"}]""")
		assertTrue(listOf(plugin, lexicon, gateway).all { it.update })
		assertEquals(plugin.text, lexicon.text)

		val withheld = refusalOf("that file is withheld")
		assertFalse(withheld.update)
		assertEquals("that file is withheld", withheld.text)
	}

	@Test
	fun `an answer for another symbol or facet draws as unreachable`() {
		val members = WorkspaceFacetAnswer.Members(members = listOf(symbol("openThread")), plain = 0)
		assertTrue(facetState(FacetEntry.MEMBERS, "s", listed("s", members)) is FacetState.Shown)
		assertEquals(FacetState.Unreachable, facetState(FacetEntry.MEMBERS, "other", listed("s", members)))
		assertEquals(FacetState.Unreachable, facetState(FacetEntry.COMMENTS, "s", listed("s", members)))
		assertEquals(FacetState.Loading, facetState(FacetEntry.MEMBERS, "s", null))

		val file = WorkspaceAnswer.Read(WorkspaceListing.Listed(fileHistory("commits", truncated = false)))
		assertTrue(fileHistoryState("src/a.ts", file) is FacetState.Shown)
		assertEquals(FacetState.Unreachable, fileHistoryState("src/b.ts", file))
	}

	////////////////////////////////
	//  Members

	@Test
	fun `members name their kind when they share one, and kind chips appear only for two kinds or more`() {
		val methods = (1..7).map { symbol("m$it", kind = "method") }
		assertEquals("7 methods, in source order", membersSubtitle(methods))
		assertEquals(emptyList<OutlineKind>(), memberChips(methods))

		val mixed = methods + symbol("held", kind = "property")
		assertEquals("8 members, in source order", membersSubtitle(mixed))
		assertEquals(listOf("All", "Method", "Property"), memberChips(mixed).map { it.label })
		assertEquals("property", kindNoun("property", 1))
		assertEquals("properties", kindNoun("property", 2))
	}

	@Test
	fun `a member chip leaves only its kind, and All leaves every member in source order`() {
		val members = listOf(symbol("m1", kind = "method"), symbol("held", kind = "property"), symbol("m2", kind = "method"))

		assertEquals(members, membersOfKind(members, null))
		assertEquals(listOf("m1", "m2"), membersOfKind(members, "method").map { it.name })
		assertEquals(emptyList<WorkspaceFacetSymbol>(), membersOfKind(members, "class"))
		// Every chip the screen offers selects the rows it counted.
		for (chip in memberChips(members).filter { it.kind != null }) {
			assertEquals(chip.count, membersOfKind(members, chip.kind).size)
		}
	}

	////////////////////////////////
	//  Hierarchy

	@Test
	fun `the hierarchy reads farthest ancestor first down to the symbol, with an unresolved base dashed and closed`() {
		val column = hierarchyColumn(
			WorkspaceFacetAnswer.Hierarchy(
				subject = symbol("LocalBackendSession", kind = "interface"),
				supertypes = listOf(WorkspaceFacetType(symbol("Base"), "extends")),
				ancestors = listOf(symbol("Nearer"), symbol("Farthest")),
				unbound = listOf(WorkspaceFacetUnboundType("Error", "extends")),
				subtypes = listOf(WorkspaceFacetType(symbol("CodexLocalSession"), "implements")),
				supertypeCount = 4,
				subtypeCount = 1,
			),
		)
		assertEquals(listOf("Farthest", "Nearer", "Base", "Error"), column.above.map { node ->
			when (node) {
				is TypeNode.Known -> node.name
				is TypeNode.Unbound -> node.name
			}
		})
		assertEquals("extends", (column.above.last() as TypeNode.Unbound).tag)
		assertEquals("interface", column.self.tag)
		assertTrue(column.self.self)
		assertFalse(column.self.opens)
		assertEquals(listOf("implements"), column.below.map { (it as TypeNode.Known).tag })
		assertTrue(column.below.all { (it as TypeNode.Known).opens })
		assertEquals(column.above.size + 1 + column.below.size, (column.above + column.self + column.below).map { it.key }.distinct().size)
	}

	////////////////////////////////
	//  Comments

	@Test
	fun `comments list in line order under their holder, split their code, and a capped page says so`() {
		val answer = WorkspaceFacetAnswer.Comments(
			comments = listOf(
				WorkspaceFacetComment("second `turn`, then `model`", "leading", 29, symbol("startTurn", kind = "method")),
				WorkspaceFacetComment("first", "trailing", 27, null),
			),
			total = 5,
		)
		val items = commentItems(answer)
		assertEquals(listOf(27L, 29L), items.map { it.line })
		assertEquals(listOf("TRAILING", "LEADING"), items.map { it.form })
		assertNull(items.first().opens)
		assertEquals(Reached("Comment", "LEADING", 29), items.last().opens!!.reached)
		assertEquals(
			listOf("second " to false, "turn" to true, ", then " to false, "model" to true),
			items.last().parts.map { it.text to it.code },
		)
		assertEquals(listOf("a `b" to false), textParts("a `b").map { it.text to it.code })
		assertEquals("5 inside it", commentsSubtitle(answer))
		assertEquals("first 2 inside it", commentsSubtitle(answer.copy(truncated = true)))
	}

	////////////////////////////////
	//  History

	private fun commit(hash: String, atMillis: Long) =
		WorkspaceHistoryCommit(hash = hash, at = atMillis / 1_000, subject = "did a thing", added = 4, removed = 1)

	private fun history(outcome: String, commits: List<WorkspaceHistoryCommit>) =
		WorkspaceFacetAnswer.History(
			outcome = outcome,
			module = "src/mcp/local/localAgentSession.ts",
			startLine = 26,
			endLine = 43,
			commits = commits,
			truncated = false,
		)

	private fun fileHistory(outcome: String, truncated: Boolean) =
		WorkspaceFileHistoryAnswer(
			path = "src/a.ts",
			outcome = outcome,
			commits = emptyList(),
			count = 3,
			added = 67,
			removed = 24,
			firstSeen = (NOW - 32 * DAY_MS) / 1_000,
			lastTouched = (NOW - 12 * DAY_MS) / 1_000,
			truncated = truncated,
		)

	@Test
	fun `history lists newest first with short hashes and ages, and says untracked, outside git or none`() {
		val body = historyBody(
			"commits",
			listOf(commit("4b54a28cafe", NOW - 12 * DAY_MS), commit("0ab0bd6beef", NOW - 28 * DAY_MS)),
			truncated = true,
			now = NOW,
		) as HistoryBody.Commits
		assertEquals(listOf("4b54a28", "0ab0bd6"), body.items.map { it.shortHash })
		assertEquals(listOf("12 days ago", "4 weeks ago"), body.items.map { it.age })
		// The plugin's cap, never the rows this answer happened to carry.
		assertEquals(2, body.items.size)
		assertEquals(HISTORY_COMMIT_CAP, body.stoppedAt)

		val whole = historyBody("commits", listOf(commit("4b54a28cafe", NOW)), truncated = false, now = NOW)
		assertNull((whole as HistoryBody.Commits).stoppedAt)

		assertTrue(historyBody("untracked", emptyList(), false, NOW) is HistoryBody.Empty)
		assertTrue(historyBody("notRepository", emptyList(), false, NOW) is HistoryBody.Empty)
		assertTrue(historyBody("commits", emptyList(), false, NOW) is HistoryBody.Empty)
		assertEquals("localAgentSession.ts, lines 26-43", historySubtitle("src/mcp/local/localAgentSession.ts", 26, 43))
		assertEquals("localAgentSession.ts, line 26", historySubtitle("src/mcp/local/localAgentSession.ts", 26, 26))
	}

	@Test
	fun `file stats read the time since the last change, commits over their span, and lines added and removed`() {
		val stats = (fileStrip(fileHistory("commits", truncated = false), NOW) as FileStrip.Stats).stats
		assertEquals("12 days", stats.sinceLast)
		assertEquals("3", stats.commits)
		assertEquals("commits in 4 weeks", stats.commitsLabel)
		assertEquals("+67" to "-24", stats.added to stats.removed)

		assertEquals("3+", (fileStrip(fileHistory("commits", truncated = true), NOW) as FileStrip.Stats).stats.commits)
		assertTrue(fileStrip(fileHistory("untracked", truncated = false), NOW) is FileStrip.Line)
	}

	@Test
	fun `ages read minutes, hours, days, weeks, months and years at each boundary`() {
		fun ago(ms: Long) = agoText(NOW - ms, NOW)
		assertEquals("just now", ago(59_000))
		assertEquals("1 min ago", ago(60_000))
		assertEquals("59 min ago", ago(59 * 60_000))
		assertEquals("1 hour ago", ago(3_600_000))
		assertEquals("23 hours ago", ago(23 * 3_600_000))
		assertEquals("1 day ago", ago(DAY_MS))
		assertEquals("13 days ago", ago(13 * DAY_MS))
		assertEquals("2 weeks ago", ago(14 * DAY_MS))
		assertEquals("7 weeks ago", ago(55 * DAY_MS))
		assertEquals("1 month ago", ago(56 * DAY_MS))
		assertEquals("12 months ago", ago(364 * DAY_MS))
		assertEquals("1 year ago", ago(365 * DAY_MS))
		assertEquals("just now", ago(-DAY_MS))
		assertEquals("12 days", spanText(12 * DAY_MS))
	}

	@Test
	fun `a count groups its digits wherever it is read`() {
		assertEquals("13", countText(13))
		assertEquals("1,200", countText(1_200))
		assertEquals("48,213 uses · 4.2 MB", tooLargeText("uses", 48_213, 4_213_377))
	}

	@Test
	fun `a symbol on one line names that line, not a range of itself`() {
		assertEquals("a.ts : 13", whereText("a.ts", 13, 13))
		assertEquals("a.ts : 13", whereText("a.ts", 13, null))
		assertEquals("a.ts : 26-43", whereText("a.ts", 26, 43))
		assertEquals("a.ts", whereText("a.ts", null, null))
	}

	////////////////////////////////
	//  Detail

	@Test
	fun `the detail reads header, reached use, facts, knowledge, documentation, then source, and the jump finds the reached line`() {
		val view = DetailView(
			source = WorkspaceAnswer.Read(
				WorkspaceSymbolSourceAnswer(
					symbolId = "s",
					module = "src/a.ts",
					name = "start",
					text = (93..130).joinToString("\n") { "line $it" },
					startLine = 93,
					endLine = 130,
					spanHash = "h",
				),
			),
			knowledge = WorkspaceAnswer.Read(WorkspaceKnowledgeAnswer(symbolId = "s", documentation = "what it does")),
		)
		val reached = Reached("LocalBackendSession", "Type", 99)
		val items = detailItems(view, reached, whole = false)

		assertEquals(
			listOf("h", "r", "f", "k", "d", "st"),
			items.take(6).map { it.key },
		)
		assertEquals(99, reachedIndex(items)!!.let { items[it] as DetailItem.SourceLine }.line.number!!.toInt())
		assertTrue(items.none { it is DetailItem.ShowAll })

		val plain = detailItems(view.copy(knowledge = null), null, whole = false)
		assertEquals(listOf("h", "f", "k", "st"), plain.take(4).map { it.key })
		assertNull(reachedIndex(plain))
	}
}
