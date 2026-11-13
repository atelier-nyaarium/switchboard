package com.atelier_nyaarium.switchboard

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A long-pressed row. */
internal data class RowPress(val team: String, val rowId: Long, val rowAt: Long)

private enum class RowAct { CLEAR, CUT }

/** Row menu, then its confirmation. */
@Composable
internal fun RowMenuDialog(
	repo: ChatRepository,
	pressState: MutableState<RowPress?>,
	claimsOf: (team: String, rows: List<Message>, left: List<Message>) -> List<CutClaim>,
) {
	var press by pressState
	val held = press ?: return
	var picked by remember(held) { mutableStateOf<RowAct?>(null) }
	val state by repo.state.collectAsState()
	val message = state.threads[held.team]?.firstOrNull { it.id == held.rowId && it.at == held.rowAt }
	val above = remember(state.threads, held) { rowAbove(state, held.team, held.rowId, held.rowAt) }
	val cuts = remember(state.teams, held) { cutOffered(state.teams.firstOrNull { it.name == held.team }) }
	if (message == null || (!cuts && above == null)) {
		LaunchedEffect(held) { press = null }
		return
	}
	when (picked) {
		null -> AlertDialog(
			onDismissRequest = { press = null },
			text = {
				if (cuts) {
					TextButton(onClick = hapticClick { picked = RowAct.CUT }) { Text(CutMode.COMPACT.label) }
				} else {
					TextButton(onClick = hapticClick { picked = RowAct.CLEAR }) { Text("Clear above") }
				}
			},
			confirmButton = {},
		)
		RowAct.CUT -> CutConfirmDialog(repo, held.team, above, state, cutRowOf(message), claimsOf) { press = null }
		RowAct.CLEAR -> above?.let { ClearConfirmDialog(repo, held.team, it, state, claimsOf) { press = null } }
	}
}

/** What a compact keeps and folds, read from the Gateway before it is confirmed, and what the phone clears with it. */
@Composable
private fun CutConfirmDialog(
	repo: ChatRepository,
	team: String,
	through: Message?,
	state: ChatState,
	row: CutRow,
	claimsOf: (team: String, rows: List<Message>, left: List<Message>) -> List<CutClaim>,
	close: () -> Unit,
) {
	val mode = CutMode.COMPACT
	val view by produceState<CutPlanView>(CutPlanView.Loading, team, row) {
		value = withContext(Dispatchers.IO) { repo.cutPlan(team, mode, row) }
	}
	val cut = remember(state.threads, state.drafts, state.scheduledSends, through) {
		through?.let { threadCut(state, team, it.id, it.at) }
	}
	val clears by produceState<List<String>?>(null, cut) {
		value = cut?.let {
			withContext(Dispatchers.IO) {
				val size = freedSize(repo.filesDir, it.freed)
				clearCountLines(it.rows.size, size.files, size.bytes, claimsOf(it.team, it.rows, it.left))
			}
		} ?: emptyList()
	}
	ConfirmDialog(
		title = mode.label,
		body = cutConfirmBody(view, clears.orEmpty()),
		confirmText = "Compact",
		onConfirm = {
			close()
			repo.command { if (startCut(team, mode, row) && through != null) clearThrough(team, through.id, through.at) }
		},
		onDismiss = close,
		confirmEnabled = view is CutPlanView.Planned && clears != null,
	)
}

@Composable
private fun ClearConfirmDialog(
	repo: ChatRepository,
	team: String,
	through: Message,
	state: ChatState,
	claimsOf: (team: String, rows: List<Message>, left: List<Message>) -> List<CutClaim>,
	close: () -> Unit,
) {
	val cut = remember(state.threads, state.drafts, state.scheduledSends, through) {
		threadCut(state, team, through.id, through.at)
	}
	if (cut == null) {
		LaunchedEffect(through) { close() }
		return
	}
	val measured by produceState<Triple<ThreadCut, FreedSize, List<CutClaim>>?>(null, cut) {
		value = withContext(Dispatchers.IO) {
			Triple(cut, freedSize(repo.filesDir, cut.freed), claimsOf(cut.team, cut.rows, cut.left))
		}
	}
	// Ignore a stale measure.
	val fresh = measured?.takeIf { it.first == cut }
	val size = fresh?.second
	ConfirmDialog(
		title = "Clear above",
		body = clearConfirmLines(cut.rows.size, size?.files ?: 0, size?.bytes ?: 0L, fresh?.third.orEmpty()).joinToString("\n"),
		confirmText = "Clear",
		onConfirm = {
			close()
			repo.command { clearThrough(team, through.id, through.at) }
		},
		onDismiss = close,
		confirmEnabled = size != null,
	)
}
