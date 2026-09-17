package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

internal data class OutlineView(val outline: WorkspaceAnswer<WorkspaceOutlineAnswer>? = null)

/** A ref's declaration now, and the file it sits in. */
internal data class RefNowView(
	val source: WorkspaceAnswer<WorkspaceSymbolSourceAnswer>? = null,
	val file: WorkspaceAnswer<WorkspaceReadAnswer>? = null,
)

/** Two reads, so the source still draws when knowledge is refused. */
internal data class DetailView(
	val source: WorkspaceAnswer<WorkspaceSymbolSourceAnswer>? = null,
	val knowledge: WorkspaceAnswer<WorkspaceKnowledgeAnswer>? = null,
) {
	val identity: SymbolIdentity?
		get() = identityOf((source as? WorkspaceAnswer.Read)?.value, (knowledge as? WorkspaceAnswer.Read)?.value)
}

/** Which half of a two-read view an answer fills, so a late one never refuses the other. */
internal enum class SymbolSlot {
	SOURCE,
	KNOWLEDGE,
	FILE,
}

/** A facet belongs to one symbol, so two facets of one symbol land apart. */
internal data class FacetKey(val target: WorkspaceTarget, val symbolId: String, val facet: WorkspaceFacet)

internal data class FacetView(val answer: WorkspaceAnswer<WorkspaceListing<WorkspaceSymbolFacetAnswer>>? = null)

internal data class FileHistoryView(val answer: WorkspaceAnswer<WorkspaceListing<WorkspaceFileHistoryAnswer>>? = null)

internal data class SymbolIdentity(
	val name: String,
	val kind: String?,
	val module: String?,
	val startLine: Long?,
	val endLine: Long?,
	val container: String? = null,
)

/** The span wins where both answer, since a window opens from it. */
internal fun identityOf(span: WorkspaceSymbolSourceAnswer?, known: WorkspaceKnowledgeAnswer?): SymbolIdentity? {
	val name = span?.name ?: known?.name ?: return null
	return SymbolIdentity(
		name = name,
		kind = known?.symbolKind,
		module = span?.module ?: known?.module,
		startLine = span?.startLine ?: known?.startLine,
		endLine = span?.endLine ?: known?.endLine,
		container = span?.container,
	)
}

internal class SymbolViews(private val host: WorkspaceHost) : ClearsOnReprovision {
	private val outlines = PublishedViews<Pair<WorkspaceTarget, String>, OutlineView>(host.generation)

	private val details = PublishedViews<Pair<WorkspaceTarget, String>, DetailView>(host.generation)

	val outlineViews: StateFlow<Map<Pair<WorkspaceTarget, String>, OutlineView>> = outlines.all

	val detailViews: StateFlow<Map<Pair<WorkspaceTarget, String>, DetailView>> = details.all

	suspend fun keepOutline(target: WorkspaceTarget, path: String) =
		outlines.keep(target to path, ::OutlineView) { ticket ->
			val read = read { it.outline(target, path) }
			outlines.update(ticket) { view -> view.copy(outline = read) }
		}

	/** Each half lands as it arrives, under a slot of its own. */
	suspend fun keepDetail(target: WorkspaceTarget, symbolId: String) =
		details.keep(target to symbolId, ::DetailView) { ticket ->
			val span = details.ticket(ticket.showing, SymbolSlot.SOURCE)
			val known = details.ticket(ticket.showing, SymbolSlot.KNOWLEDGE)
			coroutineScope {
				launch {
					val read = read { it.symbolSource(target, symbolId) }
					details.update(span) { view -> view.copy(source = read) }
				}
				val read = read { it.knowledge(target, symbolId) }
				details.update(known) { view -> view.copy(knowledge = read) }
			}
		}

	/** The prose a recorded answer just gained. Nothing when the page is not showing that symbol. */
	suspend fun reloadKnowledge(target: WorkspaceTarget, symbolId: String) {
		val ticket = details.begin(target to symbolId, SymbolSlot.KNOWLEDGE) ?: return
		val read = read { it.knowledge(target, symbolId) }
		details.update(ticket) { view -> view.copy(knowledge = read) }
	}

	private val facets = PublishedViews<FacetKey, FacetView>(host.generation)

	private val fileHistories = PublishedViews<Pair<WorkspaceTarget, String>, FileHistoryView>(host.generation)

	val facetViews: StateFlow<Map<FacetKey, FacetView>> = facets.all

	val fileHistoryViews: StateFlow<Map<Pair<WorkspaceTarget, String>, FileHistoryView>> = fileHistories.all

	suspend fun keepFacet(target: WorkspaceTarget, symbolId: String, facet: WorkspaceFacet) =
		facets.keep(FacetKey(target, symbolId, facet), ::FacetView) { ticket ->
			val read = read { it.symbolFacet(target, symbolId, facet) }
			facets.update(ticket) { view -> view.copy(answer = read) }
		}

	suspend fun keepFileHistory(target: WorkspaceTarget, path: String) =
		fileHistories.keep(target to path, ::FileHistoryView) { ticket ->
			val read = read { it.fileHistory(target, path) }
			fileHistories.update(ticket) { view -> view.copy(answer = read) }
		}

	private val refNows = PublishedViews<Pair<WorkspaceTarget, String>, RefNowView>(host.generation)

	val refNowViews: StateFlow<Map<Pair<WorkspaceTarget, String>, RefNowView>> = refNows.all

	/** The file is read after the span, from the module the span names. */
	suspend fun keepRefNow(target: WorkspaceTarget, symbolId: String) =
		refNows.keep(target to symbolId, ::RefNowView) { ticket ->
			val span = refNows.ticket(ticket.showing, SymbolSlot.SOURCE)
			val source = read { it.symbolSource(target, symbolId) }
			refNows.update(span) { view -> view.copy(source = source) }
			val module = (source as? WorkspaceAnswer.Read)?.value?.module ?: return@keep
			val inFile = refNows.ticket(ticket.showing, SymbolSlot.FILE)
			val file = read { it.file(target, module) }
			refNows.update(inFile) { view -> view.copy(file = file) }
		}

	override suspend fun clearInMemory() {
		outlines.clear()
		details.clear()
		refNows.clear()
		facets.clear()
		fileHistories.clear()
	}

	/** A throw is no answer. */
	private suspend fun <T> read(call: suspend (WorkspaceGateway) -> WorkspaceAnswer<T>): WorkspaceAnswer<T> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return try {
			call(gate)
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("SymbolViews", "read failed: ${e.message}")
			WorkspaceAnswer.Unreachable
		}
	}
}
