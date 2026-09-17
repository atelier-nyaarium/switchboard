package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ID = "lexicon typescript src/a.ts f()."

class SymbolViewsTest {
	private class Reads : WorkspaceGateway {
		val sourceHolds = mutableListOf<TestHold>()
		val outlineHolds = mutableListOf<TestHold>()
		val facetHolds = mutableMapOf<WorkspaceFacet, MutableList<TestHold>>()
		val facetReads = mutableMapOf<WorkspaceFacet, Int>()
		var outlineReads = 0
		var knowledgeName = "known"

		fun hold(facet: WorkspaceFacet, hold: TestHold) {
			facetHolds.getOrPut(facet) { mutableListOf() } += hold
		}

		override suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer> {
			outlineReads++
			outlineHolds.removeFirstOrNull()?.pass()
			return WorkspaceAnswer.Read(WorkspaceOutlineAnswer(path = path, symbols = emptyList(), lines = outlineReads.toLong()))
		}

		override suspend fun symbolSource(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceSymbolSourceAnswer> {
			sourceHolds.removeFirstOrNull()?.pass()
			return WorkspaceAnswer.Read(
				WorkspaceSymbolSourceAnswer(
					symbolId = symbolId,
					module = "src/a.ts",
					name = "f",
					text = "fun f() {}",
					startLine = 4,
					endLine = 6,
					spanHash = "h1",
				),
			)
		}

		override suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer> =
			WorkspaceAnswer.Read(WorkspaceKnowledgeAnswer(symbolId = symbolId, name = knowledgeName, symbolKind = "function"))

		override suspend fun tree(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun file(target: WorkspaceTarget, path: String) = error("not reached")

		override suspend fun saveSpan(target: WorkspaceTarget, symbolId: String, expectedSpanHash: String, text: String) =
			error("not reached")

		override suspend fun mutateFile(target: WorkspaceTarget, mutation: WorkspaceFileMutation) = error("not reached")

		override suspend fun fileState(target: WorkspaceTarget, path: String) = error("not reached")

		/** The read's ordinal rides in the answer, so a reload is told from the answer it replaced. */
		override suspend fun symbolFacet(
			target: WorkspaceTarget,
			symbolId: String,
			facet: WorkspaceFacet,
		): WorkspaceAnswer<WorkspaceListing<WorkspaceSymbolFacetAnswer>> {
			val at = (facetReads[facet] ?: 0) + 1
			facetReads[facet] = at
			facetHolds[facet]?.removeFirstOrNull()?.pass()
			val answer = when (facet) {
				WorkspaceFacet.Comments -> WorkspaceFacetAnswer.Comments(comments = emptyList(), total = at.toLong())
				else -> WorkspaceFacetAnswer.Members(members = emptyList(), plain = at.toLong())
			}
			return WorkspaceAnswer.Read(WorkspaceListing.Listed(WorkspaceSymbolFacetAnswer(symbolId = symbolId, facet = answer)))
		}

		override suspend fun fileHistory(target: WorkspaceTarget, path: String) =
			WorkspaceAnswer.Read(
				WorkspaceListing.Listed(
					WorkspaceFileHistoryAnswer(
						path = path,
						outcome = "commits",
						commits = emptyList(),
						count = 1,
						added = 0,
						removed = 0,
						truncated = false,
					),
				),
			)

		override suspend fun knowledgeScope(target: WorkspaceTarget, scope: WorkspaceKnowledgeScopeTarget, includeLocals: Boolean) =
			error("not reached")
	}

	private class Host(override val workspace: WorkspaceGateway?) : WorkspaceHost {
		override val generation = WorkspaceGeneration()

		override suspend fun send(address: String, text: String) = error("not reached")
	}

	private val reads = Reads()
	private val host = Host(reads)
	private val views = SymbolViews(host)
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")

	@Test
	fun `knowledge draws while the source is still out, and the identity takes the span once it lands`() = runBlocking {
		val hold = TestHold().also { reads.sourceHolds += it }
		val keeping = launch { views.keepDetail(one, ID) }
		hold.entered.await()
		val early = withTimeout(5_000) { views.detailViews.first { it[one to ID]?.knowledge != null } }.getValue(one to ID)

		assertNull(early.source)
		assertEquals(SymbolIdentity("known", "function", null, null, null), early.identity)

		hold.release()
		val landed = withTimeout(5_000) { views.detailViews.first { it[one to ID]?.source != null } }.getValue(one to ID)
		assertEquals(SymbolIdentity("f", "function", "src/a.ts", 4, 6), landed.identity)

		keeping.cancelAndJoin()
		assertNull(views.detailViews.value[one to ID])
	}

	// A screen's successor can start before the screen it replaces has finished leaving.
	@Test
	fun `a second screen on the same outline keeps it drawn when the first one leaves`() = runBlocking {
		val first = launch { views.keepOutline(one, "src/a.ts") }
		withTimeout(5_000) { views.outlineViews.first { it[one to "src/a.ts"]?.outline is WorkspaceAnswer.Read } }
		val second = launch { views.keepOutline(one, "src/a.ts") }
		yield()

		first.cancelAndJoin()
		yield()

		assertEquals(1, reads.outlineReads)
		assertEquals(1L, (views.outlineViews.value.getValue(one to "src/a.ts").outline as WorkspaceAnswer.Read).value.lines)
		second.cancelAndJoin()
		assertNull(views.outlineViews.value[one to "src/a.ts"])
	}

	@Test
	fun `an outline left before its read lands draws nothing, and one kept reloads after a re-provision`() = runBlocking {
		val late = TestHold().also { reads.outlineHolds += it }
		val left = launch { views.keepOutline(one, "src/a.ts") }
		late.entered.await()
		left.cancelAndJoin()
		late.release()
		yield()
		assertNull(views.outlineViews.value[one to "src/a.ts"])

		val keeping = launch { views.keepOutline(one, "src/a.ts") }
		withTimeout(5_000) { views.outlineViews.first { it[one to "src/a.ts"]?.outline is WorkspaceAnswer.Read } }
		host.generation.advance()
		views.clearInMemory()
		val reloaded = withTimeout(5_000) {
			views.outlineViews.first { (it[one to "src/a.ts"]?.outline as? WorkspaceAnswer.Read)?.value?.lines == 3L }
		}

		assertEquals(3, reads.outlineReads)
		assertEquals(3L, (reloaded.getValue(one to "src/a.ts").outline as WorkspaceAnswer.Read).value.lines)
		keeping.cancelAndJoin()
	}

	private val members = FacetKey(one, ID, WorkspaceFacet.Members)
	private val comments = FacetKey(one, ID, WorkspaceFacet.Comments)

	private fun facetOf(views: Map<FacetKey, FacetView>, key: FacetKey): WorkspaceFacetAnswer? =
		((views[key]?.answer as? WorkspaceAnswer.Read)?.value as? WorkspaceListing.Listed)?.value?.facet

	private fun totalOf(views: Map<FacetKey, FacetView>, key: FacetKey): Long? =
		(facetOf(views, key) as? WorkspaceFacetAnswer.Comments)?.total

	@Test
	fun `two facets of one symbol read and land apart, so a late answer for one never draws on the other`() = runBlocking {
		val held = TestHold().also { reads.hold(WorkspaceFacet.Members, it) }
		val keptMembers = launch { views.keepFacet(one, ID, WorkspaceFacet.Members) }
		held.entered.await()
		val keptComments = launch { views.keepFacet(one, ID, WorkspaceFacet.Comments) }
		val early = withTimeout(5_000) { views.facetViews.first { it[comments]?.answer != null } }

		assertNull(early[members]?.answer)

		held.release()
		val both = withTimeout(5_000) { views.facetViews.first { it[members]?.answer != null } }

		assertTrue(facetOf(both, members) is WorkspaceFacetAnswer.Members)
		assertTrue(facetOf(both, comments) is WorkspaceFacetAnswer.Comments)

		keptMembers.cancelAndJoin()
		keptComments.cancelAndJoin()
	}

	@Test
	fun `a facet left before its read lands draws nothing, and one kept reads again after a re-provision`() = runBlocking {
		val late = TestHold().also { reads.hold(WorkspaceFacet.Comments, it) }
		val left = launch { views.keepFacet(one, ID, WorkspaceFacet.Comments) }
		late.entered.await()
		left.cancelAndJoin()
		late.release()
		yield()
		assertNull(views.facetViews.value[comments])

		val keeping = launch { views.keepFacet(one, ID, WorkspaceFacet.Comments) }
		withTimeout(5_000) { views.facetViews.first { it[comments]?.answer != null } }
		host.generation.advance()
		views.clearInMemory()
		withTimeout(5_000) { views.facetViews.first { totalOf(it, comments) == 3L } }

		assertEquals(3, reads.facetReads[WorkspaceFacet.Comments])
		keeping.cancelAndJoin()
	}

	@Test
	fun `a second screen keeping the same facet reads once`() = runBlocking {
		val first = launch { views.keepFacet(one, ID, WorkspaceFacet.Members) }
		withTimeout(5_000) { views.facetViews.first { it[members]?.answer != null } }
		val second = launch { views.keepFacet(one, ID, WorkspaceFacet.Members) }
		yield()

		first.cancelAndJoin()
		yield()

		assertEquals(1, reads.facetReads[WorkspaceFacet.Members])
		assertNotNull(views.facetViews.value[members]?.answer)
		second.cancelAndJoin()
		assertNull(views.facetViews.value[members])
	}

	@Test
	fun `file history lands beside the outline without reading the outline again`() = runBlocking {
		val outline = launch { views.keepOutline(one, "src/a.ts") }
		withTimeout(5_000) { views.outlineViews.first { it[one to "src/a.ts"]?.outline != null } }
		val history = launch { views.keepFileHistory(one, "src/a.ts") }
		withTimeout(5_000) { views.fileHistoryViews.first { it[one to "src/a.ts"]?.answer != null } }

		assertEquals(1, reads.outlineReads)

		history.cancelAndJoin()
		assertNull(views.fileHistoryViews.value[one to "src/a.ts"])
		assertNotNull(views.outlineViews.value[one to "src/a.ts"]?.outline)
		outline.cancelAndJoin()
	}
}
