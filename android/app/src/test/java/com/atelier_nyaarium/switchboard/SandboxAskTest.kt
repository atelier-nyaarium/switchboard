package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ADDRESS = "home.sakura.host.aaa"

private val NOTHING_ASKED = AskedLookup { _, _ -> false }

class SandboxAskTest {
	private val modules = sandboxModules()

	private var clock = 1_800_000_000_000L

	private val scopes = SandboxScopes(modules) { clock }

	private val target = WorkspaceTarget(gatewayId = "sakura", address = ADDRESS)

	private val sessionId = sandboxSymbolId("typescript", SESSION_MODULE, "LocalBackendSession")

	private val openThreadId = sandboxSymbolId("typescript", SESSION_MODULE, "LocalBackendSession:openThread")

	private val subject = AskSubject(target, sessionId, "LocalBackendSession", SESSION_MODULE)

	private fun read(
		scope: WorkspaceKnowledgeScopeTarget,
		includeLocals: Boolean = false,
	): WorkspaceKnowledgeScopeAnswer {
		val listing = (scopes.scope(ADDRESS, scope, includeLocals) as WorkspaceAnswer.Read).value
		return (listing as WorkspaceListing.Listed).value
	}

	private fun members(includeLocals: Boolean = false) =
		read(WorkspaceKnowledgeScopeTarget.Members(sessionId), includeLocals)

	private fun recordedIn(answer: WorkspaceKnowledgeScopeAnswer, symbolId: String? = null): Int =
		answer.symbols.filter { symbolId == null || it.symbolId == symbolId }
			.sumOf { symbol -> symbol.questions.count { it.createdAt != null } }

	private fun picksOf(answer: WorkspaceKnowledgeScopeAnswer, of: AskSubject, scope: AskScope): List<AskPick> =
		picks(scopeSymbols(answer, of, scope), defaultSelection(null).copy(scope = scope, root = answer.root), NOTHING_ASKED)

	@Test
	fun `a scope lists members before their container with the mock's counts`() {
		val symbol = members()
		val file = read(WorkspaceKnowledgeScopeTarget.File(SESSION_MODULE))

		assertEquals(1, scopeSymbols(symbol, subject, AskScope.SYMBOL).size)
		assertEquals(8, symbol.symbols.size)
		assertEquals(15, file.symbols.size)
		assertEquals(sessionId, symbol.symbols.last().symbolId)
		assertEquals(18L, symbol.localsExcluded)
		assertEquals(18L, file.localsExcluded)

		val withLocals = members(includeLocals = true)
		assertEquals(26, withLocals.symbols.size)
		assertEquals(0L, withLocals.localsExcluded)
	}

	@Test
	fun `the sandbox reads back the pairs an Ask message names, a few per read`() {
		val before = members()
		val picked = picksOf(before, subject, AskScope.MEMBERS)
		assertEquals(48, picked.sumOf { it.questions.size })

		scopes.onMessage(ADDRESS, askMessage(subject, AskScope.MEMBERS, before, picked))
		clock += 60_000

		val first = members()
		assertEquals(6, recordedIn(first))
		assertEquals(6, recordedIn(first, openThreadId))
		assertEquals(0, recordedIn(first, sessionId))

		assertEquals(12, recordedIn(members()))
	}

	@Test
	fun `a tree line naming a symbol the sandbox does not hold records nothing and delays no known pair`() {
		val known = members().symbols.single { it.symbolId == sessionId }
		val unknown = known.copy(symbolId = "lexicon typescript src/gone.ts vanished", name = "vanished")
		val answer = WorkspaceKnowledgeScopeAnswer(
			root = SANDBOX_ROOT,
			module = SESSION_MODULE,
			symbols = listOf(unknown, known),
			localsExcluded = 0,
		)

		scopes.onMessage(ADDRESS, askMessage(subject, AskScope.FILE, answer, picksOf(answer, subject, AskScope.FILE)))
		clock += 60_000

		assertEquals(6, recordedIn(members(), sessionId))
	}

	@Test
	fun `a whole-file message over the hub exceeds the budget`() {
		val hub = AskSubject(target, sandboxSymbolId("typescript", HUB_MODULE, "hubEvent"), "hubEvent", HUB_MODULE)
		val file = read(WorkspaceKnowledgeScopeTarget.File(HUB_MODULE))

		assertTrue(file.symbols.size > HUB_KEY_COUNT)
		assertNotNull(overBudget(askMessage(hub, AskScope.FILE, file, picksOf(file, hub, AskScope.FILE))))
	}

	@Test
	fun `a module no canned workspace holds refuses with an update`() {
		val refused = scopes.scope(ADDRESS, WorkspaceKnowledgeScopeTarget.File("src/shared/schemasRoutine.ts"), false)

		assertTrue(refusalOf((refused as WorkspaceAnswer.Refused).reason).update)
	}
}
