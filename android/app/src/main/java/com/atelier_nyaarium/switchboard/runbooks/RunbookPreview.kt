package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.SaveRefusal
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.standingRefusal
import kotlinx.coroutines.delay

internal const val PREVIEW_SETTLE_MS = 400L

/** Shown words stay while the next render is out. */
internal fun PreviewState.stale(): PreviewState =
	(this as? PreviewState.Ready)?.let { PreviewState.Stale(it.text) } ?: PreviewState.Pending

/** No answer reads as the standing refusal, else a Gateway that did not answer. */
internal fun previewOf(answer: ConsoleRunbookPreviewResult?, refusal: SaveRefusal?): PreviewState = when {
	answer == null -> PreviewState.Blocked(refusal?.reason, canOverwrite = refusal != null)
	answer.text != null -> PreviewState.Ready(answer.text, answer.revision)
	else -> PreviewState.Refused(answer.reason ?: "these values do not render")
}

internal suspend fun settledPreview(
	repo: ChatRepository,
	gatewayId: String,
	runbookId: String,
	values: Map<String, String>,
	revision: Long,
): PreviewState {
	delay(PREVIEW_SETTLE_MS)
	val answer = repo.runbookOps.preview(runbookId, values, gatewayId)
	val refusal = if (answer == null) standingRefusal(repo.runbookOps.refusalFor(gatewayId, runbookId), revision) else null
	return previewOf(answer, refusal)
}
