package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FacetUseRulesTest {
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

	private fun headers(items: List<UseItem>) = items.filterIsInstance<UseItem.Header>()

	private fun rows(items: List<UseItem>) = items.filterIsInstance<UseItem.Row>()

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
}
