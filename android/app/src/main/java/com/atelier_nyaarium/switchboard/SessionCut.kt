package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleSessionCutPlanResult
import com.atelier_nyaarium.switchboard.proto.ConsoleSessionCutStartResult
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import kotlinx.coroutines.flow.update

////////////////////////////////
//  Interfaces & Types

internal enum class CutMode(val wire: String, val label: String) {
	COMPACT("compact", "Compact and clear above"),
}

/** The pressed row the Gateway finds a turn by: its time, and its text when the owner sent it. */
internal data class CutRow(val at: Long, val text: String?)

internal sealed interface CutPlanView {
	data object Loading : CutPlanView
	data class Planned(val lines: List<String>) : CutPlanView
	data class Refused(val line: String) : CutPlanView
}

////////////////////////////////
//  Functions & Helpers

/** A Claude session on the host, never the assistant's. */
internal fun cutOffered(row: Team?): Boolean {
	if (row == null || row.role == "assistant") return false
	val address = runIsolated { parseQualifiedTarget(row.name) }.getOrNull() as? Address ?: return false
	if (address.spawn != "host") return false
	return when (val word = row.harness) {
		is HarnessWord.Named -> word.harness.cuts
		is HarnessWord.Unnamed -> word.assumed.cuts
		HarnessWord.Unpicked, is HarnessWord.Unknown -> false
	}
}

/** The owner's own words find their turn; any other row finds the turn it fell in. */
internal fun cutRowOf(message: Message): CutRow =
	CutRow(message.at, message.text.takeIf { message.fromMe && !message.isPeer && it.isNotBlank() })

/** One decimal past a megabyte. */
internal fun sizeText(bytes: Long): String = when {
	bytes >= 1L shl 30 -> "%.1f GB".format(java.util.Locale.ROOT, bytes / (1L shl 30).toDouble())
	bytes >= 1L shl 20 -> "%.1f MB".format(java.util.Locale.ROOT, bytes / (1L shl 20).toDouble())
	else -> "${Math.round(bytes / 1024.0).coerceAtLeast(1)} KB"
}

internal fun cutPlanView(answer: ConsoleSessionCutPlanResult?): CutPlanView {
	if (answer == null) return CutPlanView.Refused("The Gateway did not answer.")
	if (!answer.planned) return CutPlanView.Refused(answer.detail ?: "The Gateway refused.")
	return CutPlanView.Planned(
		listOf(
			"Session file:",
			"- ${sizeText(answer.sourceBytes ?: 0)} now",
			"- ~${sizeText(answer.keptBytes ?: 0)} after",
		),
	)
}

/** A plan's lines, then what the phone clears with it. */
internal fun cutConfirmBody(view: CutPlanView, clears: List<String>): String = when (view) {
	CutPlanView.Loading -> "Reading the session..."
	is CutPlanView.Refused -> view.line
	is CutPlanView.Planned ->
		(view.lines + if (clears.isEmpty()) emptyList() else listOf("", "This phone, above this message:") + clears)
			.joinToString("\n")
}

/** A start refused, as the owner reads it; null once started. */
internal fun cutStartLine(answer: ConsoleSessionCutStartResult?): String? = when {
	answer == null -> "The Gateway did not answer, so the compact may not have started."
	answer.started -> null
	else -> "Cannot compact. ${answer.detail ?: "The Gateway refused."}"
}

/** The plan for a pressed row, read for the confirmation. */
internal suspend fun ChatRepository.cutPlan(team: String, mode: CutMode, row: CutRow): CutPlanView =
	runCatchingCancellable { clientOrNull()?.sessionCutPlan(team, mode.wire, row) }
		.fold(::cutPlanView) { CutPlanView.Refused(it.message ?: "The Gateway refused.") }

/** Starts the cut; its end arrives in the thread. A refusal is told at once. True once started. */
internal suspend fun ChatRepository.startCut(team: String, mode: CutMode, row: CutRow): Boolean {
	val line = runCatchingCancellable { clientOrNull()?.sessionCutStart(team, mode.wire, row) }
		.fold(::cutStartLine) { "Cannot compact. ${it.message ?: "The Gateway refused."}" }
	line?.let { refused -> _state.update { it.copy(error = refused) } }
	return line == null
}

internal suspend fun ConsoleClient.sessionCutPlan(target: String, mode: String, row: CutRow): ConsoleSessionCutPlanResult =
	valueResult(
		sendValueOp(transport.gatewayOf(target), ConsoleOp.SessionCutPlan(target = target, mode = mode, rowAt = row.at, rowText = row.text)),
		Protocol.Wire.ConsoleOpKind.SESSION_CUT_PLAN,
	)

internal suspend fun ConsoleClient.sessionCutStart(target: String, mode: String, row: CutRow): ConsoleSessionCutStartResult =
	valueResult(
		sendValueOp(transport.gatewayOf(target), ConsoleOp.SessionCutStart(target = target, mode = mode, rowAt = row.at, rowText = row.text)),
		Protocol.Wire.ConsoleOpKind.SESSION_CUT_START,
	)
