package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

internal data class OutlineView(val outline: WorkspaceAnswer<WorkspaceOutlineAnswer>? = null)

/** Two reads, so the source still draws when knowledge is refused. */
internal data class DetailView(
	val source: WorkspaceAnswer<WorkspaceSymbolSourceAnswer>? = null,
	val knowledge: WorkspaceAnswer<WorkspaceKnowledgeAnswer>? = null,
) {
	val identity: SymbolIdentity?
		get() = identityOf((source as? WorkspaceAnswer.Read)?.value, (knowledge as? WorkspaceAnswer.Read)?.value)
}

internal data class SymbolIdentity(
	val name: String,
	val kind: String?,
	val module: String?,
	val startLine: Long?,
	val endLine: Long?,
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
	)
}

internal class SymbolViews(private val host: WorkspaceHost) : ClearsOnReprovision {
	private val outlines = PublishedViews<Pair<WorkspaceTarget, String>, OutlineView>(host.generation)

	private val details = PublishedViews<Pair<WorkspaceTarget, String>, DetailView>(host.generation)

	val outlineViews: StateFlow<Map<Pair<WorkspaceTarget, String>, OutlineView>> = outlines.all

	val detailViews: StateFlow<Map<Pair<WorkspaceTarget, String>, DetailView>> = details.all

	suspend fun keepOutline(target: WorkspaceTarget, path: String) =
		outlines.keep(target to path, ::OutlineView) { showing ->
			val read = read { it.outline(target, path) }
			outlines.update(showing) { view -> view.copy(outline = read) }
		}

	/** Each half lands as it arrives. */
	suspend fun keepDetail(target: WorkspaceTarget, symbolId: String) =
		details.keep(target to symbolId, ::DetailView) { showing ->
			coroutineScope {
				launch {
					val read = read { it.symbolSource(target, symbolId) }
					details.update(showing) { view -> view.copy(source = read) }
				}
				val read = read { it.knowledge(target, symbolId) }
				details.update(showing) { view -> view.copy(knowledge = read) }
			}
		}

	override suspend fun clearInMemory() {
		outlines.clear()
		details.clear()
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
