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

/** Row menu, then its clear confirmation. */
@Composable
internal fun RowMenuDialog(repo: ChatRepository, pressState: MutableState<RowPress?>) {
	var press by pressState
	val held = press ?: return
	var confirming by remember(held) { mutableStateOf(false) }
	if (!confirming) {
		AlertDialog(
			onDismissRequest = { press = null },
			text = { TextButton(onClick = hapticClick { confirming = true }) { Text("Clear and all above") } },
			confirmButton = {},
		)
		return
	}
	val state by repo.state.collectAsState()
	val cut = remember(state.threads, state.drafts, state.scheduledSends, held) {
		threadCut(state, held.team, held.rowId, held.rowAt)
	}
	if (cut == null) {
		LaunchedEffect(held) { press = null }
		return
	}
	val measured by produceState<Pair<ThreadCut, FreedSize>?>(null, cut) {
		value = cut to withContext(Dispatchers.IO) { freedSize(repo.filesDir, cut.freed) }
	}
	// Ignore a stale measure.
	val size = measured?.takeIf { it.first == cut }?.second
	ConfirmDialog(
		title = "Clear and all above",
		body = clearConfirmLines(cut.rows.size, size?.files ?: 0, size?.bytes ?: 0L).joinToString("\n"),
		confirmText = "Clear",
		onConfirm = {
			press = null
			repo.command { clearThrough(held.team, held.rowId, held.rowAt) }
		},
		onDismiss = { press = null },
		confirmEnabled = size != null,
	)
}
