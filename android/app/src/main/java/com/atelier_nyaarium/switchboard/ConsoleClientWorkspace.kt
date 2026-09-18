package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspacePaintTextAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSaveSpanAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTooLargeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive

/**
 * Three outcomes, never two: the gateway refusing is its word about the workspace, and being
 * unreachable is no word at all. Collapsing them would draw a withheld file as a dropped connection.
 */
internal sealed interface WorkspaceAnswer<out T> {
	data class Read<T>(val value: T) : WorkspaceAnswer<T>

	data class Refused(val reason: String) : WorkspaceAnswer<Nothing>

	data object Unreachable : WorkspaceAnswer<Nothing>
}

/** Over cap: a count, not rows. */
internal sealed interface WorkspaceListing<out T> {
	data class Listed<T>(val value: T) : WorkspaceListing<T>

	data class TooLarge(val rows: Long, val bytes: Long?) : WorkspaceListing<Nothing>
}

/** Null when neither shape decodes. */
internal fun <T> listingOf(result: JsonElement, serializer: KSerializer<T>): WorkspaceListing<T>? =
	runIsolated {
		val kind = (result as? JsonObject)?.get("kind")?.jsonPrimitive?.contentOrNull
		if (kind == TOO_LARGE_KIND) {
			wireJson.decodeFromJsonElement(WorkspaceTooLargeAnswer.serializer(), result)
				.let { WorkspaceListing.TooLarge(it.rows, it.bytes) }
		} else {
			WorkspaceListing.Listed(wireJson.decodeFromJsonElement(serializer, result))
		}
	}.getOrNull()

private const val TOO_LARGE_KIND = "tooLarge"

private suspend fun <T> ConsoleClient.workspaceListing(
	gatewayId: String,
	op: ConsoleOp,
	serializer: KSerializer<T>,
): WorkspaceAnswer<WorkspaceListing<T>> =
	when (val answer = workspaceRead<JsonElement>(gatewayId, op)) {
		is WorkspaceAnswer.Read -> listingOf(answer.value, serializer)?.let { WorkspaceAnswer.Read(it) }
			?: WorkspaceAnswer.Unreachable
		is WorkspaceAnswer.Refused -> answer
		WorkspaceAnswer.Unreachable -> WorkspaceAnswer.Unreachable
	}

private suspend inline fun <reified T> ConsoleClient.workspaceRead(
	gatewayId: String,
	op: ConsoleOp,
): WorkspaceAnswer<T> {
	// A throwing transport would cancel the screen's effect, leaving it on a spinner with no answer.
	// Cancellation is rethrown, or a caller Compose already cancelled runs on past the await and writes
	// what the screen it belonged to no longer wants.
	val answer = try {
		sendValueAnswer(gatewayId, op)
	} catch (e: kotlin.coroutines.cancellation.CancellationException) {
		throw e
	} catch (_: Exception) {
		return WorkspaceAnswer.Unreachable
	} ?: return WorkspaceAnswer.Unreachable
	return when (answer) {
		is ConsoleClient.ValueAnswer.Answered -> {
			// An undecodable answer is a peer this build cannot read, not a refusal about the file.
			val decoded = runIsolated { wireJson.decodeFromJsonElement<T>(answer.result) }.getOrNull()
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

internal suspend fun ConsoleClient.workspacePaintText(
	gatewayId: String,
	target: String,
	path: String,
	text: String,
): WorkspaceAnswer<WorkspacePaintTextAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspacePaintText(target = target, path = path, text = text))

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

internal suspend fun ConsoleClient.workspaceSaveSpan(
	gatewayId: String,
	target: String,
	symbolId: String,
	expectedSpanHash: String,
	text: String,
): WorkspaceAnswer<WorkspaceSaveSpanAnswer> =
	workspaceRead(
		gatewayId,
		ConsoleOp.WorkspaceSaveSpan(target = target, symbolId = symbolId, expectedSpanHash = expectedSpanHash, text = text),
	)

internal suspend fun ConsoleClient.workspaceMutateFile(
	gatewayId: String,
	target: String,
	mutation: WorkspaceFileMutation,
): WorkspaceAnswer<WorkspaceFileMutationAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspaceMutateFile(target = target, mutation = mutation))

internal suspend fun ConsoleClient.workspaceFileState(
	gatewayId: String,
	target: String,
	path: String,
): WorkspaceAnswer<WorkspaceFileStateAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspaceFileState(target = target, path = path))

internal suspend fun ConsoleClient.workspaceSymbolKnowledge(
	gatewayId: String,
	target: String,
	symbolId: String,
): WorkspaceAnswer<WorkspaceKnowledgeAnswer> =
	workspaceRead(gatewayId, ConsoleOp.WorkspaceSymbolKnowledge(target = target, symbolId = symbolId))

internal suspend fun ConsoleClient.workspaceSymbolFacet(
	gatewayId: String,
	target: String,
	symbolId: String,
	facet: WorkspaceFacet,
): WorkspaceAnswer<WorkspaceListing<WorkspaceSymbolFacetAnswer>> =
	workspaceListing(
		gatewayId,
		ConsoleOp.WorkspaceSymbolFacet(target = target, symbolId = symbolId, facet = facet),
		WorkspaceSymbolFacetAnswer.serializer(),
	)

internal suspend fun ConsoleClient.workspaceFileHistory(
	gatewayId: String,
	target: String,
	path: String,
): WorkspaceAnswer<WorkspaceListing<WorkspaceFileHistoryAnswer>> =
	workspaceListing(
		gatewayId,
		ConsoleOp.WorkspaceFileHistory(target = target, path = path),
		WorkspaceFileHistoryAnswer.serializer(),
	)

internal suspend fun ConsoleClient.workspaceKnowledgeScope(
	gatewayId: String,
	target: String,
	scope: WorkspaceKnowledgeScopeTarget,
	includeLocals: Boolean,
): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> =
	workspaceListing(
		gatewayId,
		ConsoleOp.WorkspaceKnowledgeScope(target = target, scope = scope, includeLocals = includeLocals),
		WorkspaceKnowledgeScopeAnswer.serializer(),
	)
