package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer

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
}

internal interface WorkspaceHost {
	val workspace: WorkspaceGateway?

	/** An apply is an ordinary message to the session, not a write plane. */
	suspend fun send(address: String, text: String): Boolean
}
