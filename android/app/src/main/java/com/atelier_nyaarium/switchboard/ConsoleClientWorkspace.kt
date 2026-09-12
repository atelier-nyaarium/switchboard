package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import kotlinx.serialization.json.decodeFromJsonElement

// A workspace belongs to a session, so every call names the gateway AND the session.

/**
 * Three outcomes, never two: the gateway refusing is its word about the workspace, and being
 * unreachable is no word at all. Collapsing them would draw a withheld file as a dropped connection.
 */
internal sealed interface WorkspaceAnswer<out T> {
	data class Read<T>(val value: T) : WorkspaceAnswer<T>

	data class Refused(val reason: String) : WorkspaceAnswer<Nothing>

	data object Unreachable : WorkspaceAnswer<Nothing>
}

private suspend inline fun <reified T> ConsoleClient.workspaceRead(
	gatewayId: String,
	op: ConsoleOp,
): WorkspaceAnswer<T> {
	val answer = sendValueAnswer(gatewayId, op)
	return when (answer) {
		is ConsoleClient.ValueAnswer.Answered -> {
			// An undecodable answer is a peer this build cannot read, not a refusal about the file.
			val decoded = runCatching { wireJson.decodeFromJsonElement<T>(answer.result) }.getOrNull()
			if (decoded == null) WorkspaceAnswer.Unreachable else WorkspaceAnswer.Read(decoded)
		}
		is ConsoleClient.ValueAnswer.Refused -> WorkspaceAnswer.Refused(answer.reason)
		is ConsoleClient.ValueAnswer.Undelivered -> WorkspaceAnswer.Unreachable
		ConsoleClient.ValueAnswer.Unreachable -> WorkspaceAnswer.Unreachable
	}
}

/** An empty path is the workspace root, which is where a tree opens. */
internal suspend fun ConsoleClient.workspaceTree(
	gatewayId: String,
	target: String,
	path: String,
): WorkspaceAnswer<WorkspaceTreeAnswer> = workspaceRead(gatewayId, ConsoleOp.WorkspaceTree(target = target, path = path))

internal suspend fun ConsoleClient.workspaceFile(
	gatewayId: String,
	target: String,
	path: String,
): WorkspaceAnswer<WorkspaceReadAnswer> = workspaceRead(gatewayId, ConsoleOp.WorkspaceFile(target = target, path = path))

internal suspend fun ConsoleClient.workspaceOutline(
	gatewayId: String,
	target: String,
	path: String,
): WorkspaceAnswer<WorkspaceOutlineAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspaceOutline(target = target, path = path))

internal suspend fun ConsoleClient.workspaceSymbolSource(
	gatewayId: String,
	target: String,
	symbolId: String,
): WorkspaceAnswer<WorkspaceSymbolSourceAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspaceSymbolSource(target = target, symbolId = symbolId))

internal suspend fun ConsoleClient.workspaceSymbolKnowledge(
	gatewayId: String,
	target: String,
	symbolId: String,
): WorkspaceAnswer<WorkspaceKnowledgeAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspaceSymbolKnowledge(target = target, symbolId = symbolId))
