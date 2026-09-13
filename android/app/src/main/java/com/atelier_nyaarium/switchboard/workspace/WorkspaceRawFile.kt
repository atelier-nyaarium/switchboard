package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.RawEdit
import com.atelier_nyaarium.switchboard.RawFileOps
import com.atelier_nyaarium.switchboard.RawNotice
import com.atelier_nyaarium.switchboard.RawView
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.fileLines
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.noticeShown
import com.atelier_nyaarium.switchboard.rawSaveNotice
import kotlinx.coroutines.launch

/** Lexicon has no part in this road. */
@Composable
internal fun WorkspaceRawFile(
	ops: RawFileOps,
	target: WorkspaceTarget,
	path: String,
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(target.key, path) { ops.open(target, path) }
	DisposableEffect(target.key, path) { onDispose { ops.leave(target, path) } }
	val views by ops.views.collectAsState()
	val held by ops.edits.collectAsState()
	val edit = held[target]?.firstOrNull { it.path == path }

	when (val view = views[target to path]) {
		is RawView.ReadOnly -> ReadOnlyFile(view)
		is RawView.Refused -> WorkspaceNotice(view.reason, modifier)
		RawView.Unreachable -> WorkspaceNotice("This session could not be reached", modifier)
		// The two flows land a frame apart, so an editable view can briefly precede its edit.
		RawView.Editable -> if (edit == null) WorkspaceAnswerBox<Unit>(null, modifier) {} else RawEditor(ops, target, edit)
		RawView.Loading, null -> WorkspaceAnswerBox<Unit>(null, modifier) {}
	}
}

@Composable
private fun ReadOnlyFile(view: RawView.ReadOnly) {
	// Lazy, or a long file builds one composable per line before anything is drawn.
	val lines = remember(view.text) { fileLines(view.text) }
	Column(Modifier.fillMaxSize()) {
		WorkspaceNotice("Read only. ${view.reason}")
		LazyColumn(Modifier.fillMaxSize().padding(vertical = 8.dp)) {
			items(lines.size, key = { lines[it].number }) { CodeLineRow(lines[it]) }
		}
	}
}

@Composable
private fun RawEditor(
	ops: RawFileOps,
	target: WorkspaceTarget,
	edit: RawEdit,
) {
	val scope = rememberCoroutineScope()
	var notice by remember(target.key, edit.path) { mutableStateOf<RawNotice?>(null) }
	var busy by remember(target.key, edit.path) { mutableStateOf(false) }

	// One action at a time; finally, or a cancellation leaves the buttons disabled.
	fun submit(work: suspend () -> Unit) {
		if (busy) return
		busy = true
		scope.launch {
			try {
				work()
			} finally {
				busy = false
			}
		}
	}

	Column(Modifier.fillMaxSize()) {
		if (edit.stale) {
			OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
				Row(
					Modifier.fillMaxWidth().padding(start = 12.dp),
					horizontalArrangement = Arrangement.spacedBy(8.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					Text("Changed on disk", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
					TextButton(
						onClick = hapticClick {
							val asked = edit.shown
							submit { notice = ops.adopt(target, edit.path)?.let { RawNotice(asked, it) } }
						},
						enabled = !busy,
					) {
						Text("Refresh")
					}
				}
			}
		}
		RawField(edit, Modifier.weight(1f)) { ops.type(target, edit.path, it) }
		noticeShown(notice, edit.shown)?.let { WorkspaceNotice(it) }
		if (edit.edited) {
			Row(
				Modifier.fillMaxWidth().padding(12.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
			) {
				OutlinedButton(
					onClick = hapticClick { ops.discard(target, edit.path) },
					enabled = !busy,
					modifier = Modifier.weight(1f),
				) {
					Text("Discard")
				}
				Button(
					onClick = hapticClick {
						val asked = edit.shown
						submit { notice = rawSaveNotice(ops.save(target, edit.path))?.let { RawNotice(asked, it) } }
					},
					enabled = !busy,
					modifier = Modifier.weight(1f),
				) {
					Text("Save")
				}
			}
		}
	}
}

/**
 * The selection lives here, since the text alone is not the field's state. It is not saved across
 * recreation: a whole file in saved instance state can exceed the parcel limit.
 */
@Composable
private fun RawField(edit: RawEdit, modifier: Modifier, onType: (String) -> Unit) {
	var value by remember(edit.incarnation) { mutableStateOf(TextFieldValue(edit.shown)) }
	if (value.text != edit.shown) value = TextFieldValue(edit.shown, TextRange(value.selection.start.coerceAtMost(edit.shown.length)))

	OutlinedTextField(
		value = value,
		onValueChange = {
			value = it
			onType(it.text)
		},
		modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
		textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
		colors = OutlinedTextFieldDefaults.colors(
			focusedBorderColor = MaterialTheme.colorScheme.primary,
			unfocusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.4f),
		),
	)
}
