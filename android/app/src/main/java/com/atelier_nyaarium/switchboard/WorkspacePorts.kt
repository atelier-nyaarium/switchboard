package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import java.util.concurrent.atomic.AtomicLong

/** A port, so a test drives every workspace ops class without a socket. */
internal interface WorkspaceGateway {
	suspend fun tree(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceTreeAnswer>

	suspend fun file(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceReadAnswer>

	suspend fun outline(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceOutlineAnswer>

	suspend fun symbolSource(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceSymbolSourceAnswer>

	suspend fun knowledge(target: WorkspaceTarget, symbolId: String): WorkspaceAnswer<WorkspaceKnowledgeAnswer>

	suspend fun saveSpan(
		target: WorkspaceTarget,
		symbolId: String,
		expectedSpanHash: String,
		text: String,
	): WorkspaceAnswer<WorkspaceSaveSpanAnswer>

	suspend fun mutateFile(
		target: WorkspaceTarget,
		mutation: WorkspaceFileMutation,
	): WorkspaceAnswer<WorkspaceFileMutationAnswer>

	suspend fun fileState(target: WorkspaceTarget, path: String): WorkspaceAnswer<WorkspaceFileStateAnswer>
}

internal interface WorkspaceHost {
	val workspace: WorkspaceGateway?

	/** Shared by every workspace ops class, so one re-provision fences all of their work at once. */
	val generation: WorkspaceGeneration

	/** An apply is an ordinary message to the session, not a write plane. */
	suspend fun send(address: String, text: String): Boolean
}

/**
 * Moves once per re-provision, before any ops class clears what it holds. Work captures it as it starts and
 * lands nothing once it has moved.
 */
internal class WorkspaceGeneration {
	private val value = AtomicLong(0)

	fun capture(): Long = value.get()

	fun isCurrent(captured: Long): Boolean = value.get() == captured

	fun advance() {
		value.incrementAndGet()
	}
}
