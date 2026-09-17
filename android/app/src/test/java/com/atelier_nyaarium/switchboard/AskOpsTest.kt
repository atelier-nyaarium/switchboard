package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeQuestion
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeSymbol
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ADDRESS = "home.sakura.host.aaa"

private const val ROOT = "/work/repo"

private const val MODULE = "src/localAgentSession.ts"

private const val ROOT_ID = "lexicon typescript src/localAgentSession.ts LocalBackendSession"

private val MEMBERS = listOf("openThread", "startTurn", "steerTurn", "interruptTurn", "onActivity", "onClosed", "close")

private fun questionsOf(createdAt: Double?) =
	QUESTION_CLASSES.map { WorkspaceScopeQuestion(question = it, createdAt = createdAt, askCount = 0) }

private fun scopeSymbol(id: String, name: String, container: String?, createdAt: Double?) =
	WorkspaceScopeSymbol(
		symbolId = id,
		name = name,
		symbolKind = if (container == null) "class" else "method",
		depth = if (container == null) 0 else 1,
		startLine = 1,
		containerId = container,
		questions = questionsOf(createdAt),
	)

/** Post-order, as Lexicon walks it. `recorded` names the symbols whose answers carry a createdAt. */
private fun membersAnswer(
	names: List<String> = MEMBERS,
	recorded: Set<String> = emptySet(),
	root: String = ROOT,
) = WorkspaceKnowledgeScopeAnswer(
	root = root,
	module = MODULE,
	symbols = names.map { scopeSymbol("$ROOT_ID.$it", it, ROOT_ID, if ("$ROOT_ID.$it" in recorded) 9.0 else null) } +
		scopeSymbol(ROOT_ID, "LocalBackendSession", null, if (ROOT_ID in recorded) 9.0 else null),
	localsExcluded = 18,
)

private fun listed(answer: WorkspaceKnowledgeScopeAnswer): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> =
	WorkspaceAnswer.Read(WorkspaceListing.Listed(answer))

class AskOpsTest {
	private class Scopes : WorkspaceGateway {
		val reads = mutableMapOf<WorkspaceKnowledgeScopeTarget, Int>()
		val holds = mutableListOf<TestHold>()
		var knowledgeReads = 0
		var answer: (WorkspaceKnowledgeScopeTarget, Int) -> WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> =
			{ _, _ -> listed(membersAnswer()) }

		override suspend fun knowledgeScope(
			target: WorkspaceTarget,
			scope: WorkspaceKnowledgeScopeTarget,
			includeLocals: Boolean,
		): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> {
			val at = (reads[scope] ?: 0) + 1
			reads[scope] = at
			holds.removeFirstOrNull()?.pass()
			return answer(scope, at)
		}

		override suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer> {
			knowledgeReads++
			return WorkspaceAnswer.Read(WorkspaceKnowledgeAnswer(symbolId = symbolId, name = "f"))
		}

		override suspend fun tree(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun file(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun outline(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun symbolSource(target: WorkspaceTarget, symbolId: String) = error("not reached")

		override suspend fun saveSpan(target: WorkspaceTarget, symbolId: String, expectedSpanHash: String, text: String) =
			error("not reached")

		override suspend fun mutateFile(target: WorkspaceTarget, mutation: WorkspaceFileMutation) = error("not reached")

		override suspend fun fileState(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun symbolFacet(target: WorkspaceTarget, symbolId: String, facet: WorkspaceFacet) = error("not reached")

		override suspend fun fileHistory(target: WorkspaceTarget, path: String) = error("not reached")
	}

	private class Host(override val workspace: WorkspaceGateway?) : WorkspaceHost {
		override val generation = WorkspaceGeneration()
		val sent = mutableListOf<String>()
		val holds = mutableListOf<TestHold>()
		var sends = true
		var throws = false

		override suspend fun send(address: String, text: String): Boolean {
			holds.removeFirstOrNull()?.pass()
			if (throws) throw IllegalStateException("socket gone")
			sent += text
			return sends
		}
	}

	private var clock = 0L
	private val gate = Scopes()
	private val host = Host(gate)
	private val reloaded = mutableListOf<Pair<WorkspaceTarget, String>>()
	private val ops = AskOps(host, ComposedRequests(host), { clock }) { target, symbolId -> reloaded += target to symbolId }

	private val target = WorkspaceTarget(gatewayId = "sakura", address = ADDRESS)
	private val subject = AskSubject(target, ROOT_ID, "LocalBackendSession", MODULE)
	private val membersTarget = WorkspaceKnowledgeScopeTarget.Members(ROOT_ID)
	private val fileTarget = WorkspaceKnowledgeScopeTarget.File(MODULE)
	private val membersKey = ScopeKey(target, membersTarget, false)
	private val fileKey = ScopeKey(target, fileTarget, false)

	private fun selection(scope: AskScope = AskScope.MEMBERS, root: String = ROOT, include: Set<Include>? = null) =
		defaultSelection(null).copy(scope = scope, root = root).let {
			if (include == null) it else it.copy(include = include)
		}

	private suspend fun awaitRead(key: ScopeKey) = withTimeout(5_000) { ops.scopeViews.first { it[key]?.read != null } }

	private fun outstanding(symbolId: String, question: String) =
		ops.store.outstanding(AskedKey(ADDRESS, ROOT, symbolId, question))

	/** The pairs the sheet showed, built as the sheet builds them. */
	private fun shown(
		answer: WorkspaceKnowledgeScopeAnswer = membersAnswer(),
		selection: AskSelection = selection(),
	): Set<AskedKey> =
		askOffer(answer, answer, answer, subject, selection, AskedLookup(::outstanding)).pairs

	@Test
	fun `a scope read under a minute old is sent as it is, without reading again`() = runBlocking {
		val keeping = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		clock += SCOPE_FRESH_MS - 1

		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))
		assertEquals(1, gate.reads[membersTarget])
		assertEquals(1, host.sent.size)

		keeping.cancelAndJoin()
	}

	@Test
	fun `a scope a minute old is read again before sending`() = runBlocking {
		val keeping = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		clock += SCOPE_FRESH_MS

		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))
		assertEquals(2, gate.reads[membersTarget])

		keeping.cancelAndJoin()
	}

	@Test
	fun `a changed root sends nothing and says so`() = runBlocking {
		assertEquals(AskSent.RootChanged, ops.send(subject, selection(root = "/work/other"), shown()))

		assertTrue(host.sent.isEmpty())
		assertTrue(ops.store.sends.value.isEmpty())
	}

	@Test
	fun `a fresh read picking another set than the sheet showed sends nothing`() = runBlocking {
		val moved = MEMBERS.dropLast(1) + "drain"
		gate.answer = { _, at -> listed(membersAnswer(names = if (at == 1) MEMBERS else moved)) }
		val keeping = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		clock += SCOPE_FRESH_MS

		// The same count, another member: the owner reviewed a set, not a number.
		assertEquals(AskSent.Changed, ops.send(subject, selection(), shown()))
		assertTrue(host.sent.isEmpty())
		assertTrue(ops.store.sends.value.isEmpty())

		// The sheet redraws from the fresh read, and the same send then lands.
		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown(membersAnswer(names = moved))))

		keeping.cancelAndJoin()
	}

	@Test
	fun `pairs are written before the send and kept when it lands`() = runBlocking {
		val hold = TestHold().also { host.holds += it }
		val sending = async { ops.send(subject, selection(), shown()) }
		hold.entered.await()

		assertTrue(outstanding(ROOT_ID, "why"))

		hold.release()
		assertEquals(AskSent.Sent(48), sending.await())
		assertTrue(outstanding(ROOT_ID, "why"))
		assertEquals(48, ops.store.sends.value.single().pairs.size)
	}

	@Test
	fun `pairs are kept when the send's outcome is unknown and removed when it failed`() = runBlocking {
		host.throws = true
		assertEquals(AskSent.Unknown(48), ops.send(subject, selection(), shown()))
		assertTrue(outstanding(ROOT_ID, "why"))

		host.throws = false
		host.sends = false
		val again = selection(include = setOf(Include.NOT_RECORDED, Include.WEAK, Include.ASKED))
		assertEquals(AskSent.Failed, ops.send(subject, again, shown(selection = again)))

		assertEquals(1, ops.store.sends.value.size)
		assertTrue(outstanding(ROOT_ID, "why"))
	}

	@Test
	fun `a second send of the same scope while one is out sends nothing and leaves the first send's pairs`() = runBlocking {
		val hold = TestHold().also { host.holds += it }
		val sending = async { ops.send(subject, selection(), shown()) }
		hold.entered.await()

		assertEquals(AskSent.NothingToAsk, ops.send(subject, selection(), shown()))
		val ticked = selection(include = setOf(Include.NOT_RECORDED, Include.WEAK, Include.ASKED))
		assertEquals(AskSent.AlreadySending, ops.send(subject, ticked, shown(selection = ticked)))

		hold.release()
		assertEquals(AskSent.Sent(48), sending.await())
		assertEquals(1, ops.store.sends.value.size)
		assertEquals(1, host.sent.size)
	}

	@Test
	fun `two sends of one scope started together produce one message`() = runBlocking {
		val hold = TestHold().also { gate.holds += it }
		val first = async { ops.send(subject, selection(), shown()) }
		hold.entered.await()
		val second = async { ops.send(subject, selection(), shown()) }
		repeat(5) { yield() }

		// The second waits for the first's preflight rather than picking beside it.
		assertEquals(1, gate.reads[membersTarget])

		hold.release()

		assertEquals(AskSent.Sent(48), first.await())
		assertEquals(AskSent.NothingToAsk, second.await())
		assertEquals(1, host.sent.size)
		assertEquals(1, ops.store.sends.value.size)
	}

	@Test
	fun `a scope read held across a re-show lands nothing and settles nothing`() = runBlocking {
		gate.answer = { _, at -> listed(if (at == 2) membersAnswer(recorded = setOf(ROOT_ID)) else membersAnswer()) }
		val keeping = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))
		clock += SCOPE_FRESH_MS

		val hold = TestHold().also { gate.holds += it }
		val sending = async { ops.send(subject, selection(), shown()) }
		hold.entered.await()

		keeping.cancelAndJoin()
		val reshown = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		hold.release()
		assertEquals(AskSent.NothingToAsk, sending.await())

		assertTrue(reloaded.isEmpty())
		assertTrue(outstanding(ROOT_ID, "why"))

		reshown.cancelAndJoin()
	}

	@Test
	fun `a sweep's read landing after a send's re-read draws nothing and settles nothing`() = runBlocking {
		gate.answer = { _, at -> listed(if (at == 2) membersAnswer(recorded = setOf(ROOT_ID)) else membersAnswer()) }
		val keeping = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))
		clock += SCOPE_FRESH_MS

		// The sweep reads first and is held; its answer says the root was recorded.
		val held = TestHold().also { gate.holds += it }
		val sweeping = async { ops.onForeground() }
		held.entered.await()

		// The send's own re-read begins after it and lands first, still finding nothing recorded.
		assertEquals(AskSent.NothingToAsk, ops.send(subject, selection(), shown()))

		held.release()
		sweeping.await()

		assertTrue(reloaded.isEmpty())
		assertTrue(outstanding(ROOT_ID, "why"))

		keeping.cancelAndJoin()
	}

	@Test
	fun `a message over the budget is refused before anything is written`() = runBlocking {
		val wide = (1..2_000).map { scopeSymbol("lexicon typescript src/hub/hub.ts ${"declaration".repeat(8)}$it", "d$it", null, null) }
		val answer = WorkspaceKnowledgeScopeAnswer(root = ROOT, module = "src/hub/hub.ts", symbols = wide, localsExcluded = 0)
		gate.answer = { _, _ -> listed(answer) }
		val whole = selection(scope = AskScope.FILE)

		val sent = ops.send(subject, whole, shown(answer, whole))

		assertTrue((sent as AskSent.TooLarge).bytes > ASK_MESSAGE_BUDGET_BYTES)
		assertTrue(host.sent.isEmpty())
		assertTrue(ops.store.sends.value.isEmpty())
	}

	@Test
	fun `on foreground each shown scope is read once while a pair is out, and nothing is read when none is`() = runBlocking {
		val keptMembers = launch { ops.keepScope(membersKey) }
		val keptFile = launch { ops.keepScope(fileKey) }
		awaitRead(membersKey)
		awaitRead(fileKey)

		ops.onForeground()
		assertEquals(1, gate.reads[membersTarget])
		assertEquals(1, gate.reads[fileTarget])

		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))
		ops.onForeground()

		assertEquals(2, gate.reads[membersTarget])
		assertEquals(2, gate.reads[fileTarget])

		keptMembers.cancelAndJoin()
		keptFile.cancelAndJoin()
	}

	@Test
	fun `a scope shown twice is read once and stays shown until both leave`() = runBlocking {
		val first = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		val second = launch { ops.keepScope(membersKey) }
		yield()

		first.cancelAndJoin()
		yield()

		assertEquals(1, gate.reads[membersTarget])
		assertEquals(ROOT, listedRoot())

		second.cancelAndJoin()
		assertNull(ops.scopeViews.value[membersKey])
	}

	@Test
	fun `a scope answer landing after a re-provision draws nothing, and the store is empty`() = runBlocking {
		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))

		val late = TestHold().also { gate.holds += it }
		val keeping = launch { ops.keepScope(membersKey) }
		late.entered.await()

		// The generation moves before any ops class clears, which is the window this read lands in.
		host.generation.advance()
		late.release()
		repeat(5) { yield() }

		assertNull(ops.scopeViews.value[membersKey]?.read)

		ops.clearInMemory()

		assertTrue(ops.store.sends.value.isEmpty())
		assertFalse(outstanding(ROOT_ID, "why"))

		keeping.cancelAndJoin()
	}

	@Test
	fun `an older plugin's refusal comes back for the sheet to draw`() = runBlocking {
		gate.answer = { _, _ -> WorkspaceAnswer.Refused("Update the plugin in this session") }

		val refused = (ops.send(subject, selection(), shown()) as AskSent.NotRead).state

		assertTrue((refused as FacetState.Refused).update)
		assertTrue(host.sent.isEmpty())
	}

	@Test
	fun `a recorded pair reloads the detail's knowledge once`() = runBlocking {
		val keeping = launch { ops.keepScope(membersKey) }
		awaitRead(membersKey)
		assertEquals(AskSent.Sent(48), ops.send(subject, selection(), shown()))

		gate.answer = { _, _ -> listed(membersAnswer(recorded = setOf(ROOT_ID))) }
		ops.onForeground()

		assertEquals(listOf(target to ROOT_ID), reloaded.toList())
		assertFalse(outstanding(ROOT_ID, "why"))
		assertTrue(outstanding("$ROOT_ID.close", "why"))

		ops.onForeground()
		assertEquals(listOf(target to ROOT_ID), reloaded.toList())

		keeping.cancelAndJoin()
	}

	private fun listedRoot(): String? =
		(scopeState(ops.scopeViews.value[membersKey]?.read?.answer) as? ScopeState.Listed)?.answer?.root
}
