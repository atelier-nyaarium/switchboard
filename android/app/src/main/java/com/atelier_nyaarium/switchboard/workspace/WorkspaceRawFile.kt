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
import androidx.compose.runtime.mutableLongStateOf
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
import com.atelier_nyaarium.switchboard.RawOpened
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.fileLines
import com.atelier_nyaarium.switchboard.hapticClick
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
	var opened by remember(target.key, path) { mutableStateOf<WorkspaceAnswer<RawOpened>?>(null) }
	var openedIn by remember(target.key, path) { mutableLongStateOf(ops.generation) }
	LaunchedEffect(target.key, path) { opened = ops.open(target, path) }
	DisposableEffect(target.key, path) { onDispose { ops.leave(target, path) } }
	val held by ops.edits.collectAsState()
	val edit = held[target]?.firstOrNull { it.path == path }
	// Let go by a recheck, so the read says what it is now. Asked of the ops class, since the collected
	// map can trail the open that just landed by a frame. A re-provision took it instead, and is not reopened.
	val letGo = edit == null && ops.editOf(target, path) == null && ops.generation == openedIn &&
		(opened as? WorkspaceAnswer.Read)?.value == RawOpened.Editable
	LaunchedEffect(target.key, path, letGo) {
		if (!letGo) return@LaunchedEffect
		openedIn = ops.generation
		opened = ops.open(target, path)
	}

	WorkspaceAnswerBox(if (letGo) null else opened, modifier) { view ->
		when (view) {
			is RawOpened.ReadOnly -> ReadOnlyFile(view)
			RawOpened.Editable -> edit?.let { RawEditor(ops, target, it, onReopened = { answer -> opened = answer }) }
		}
	}
}

@Composable
private fun ReadOnlyFile(view: RawOpened.ReadOnly) {
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
	onReopened: (WorkspaceAnswer<RawOpened>) -> Unit,
) {
	val scope = rememberCoroutineScope()
	var notice by remember(target.key, edit.path) { mutableStateOf<String?>(null) }
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
							submit {
								// Only a read replaces the editor; anything else keeps the typing on screen.
								when (val reopened = ops.adopt(target, edit.path)) {
									is WorkspaceAnswer.Read -> {
										notice = null
										onReopened(reopened)
									}
									is WorkspaceAnswer.Refused -> notice = reopened.reason
									WorkspaceAnswer.Unreachable -> notice = "This session could not be reached"
								}
							}
						},
						enabled = !busy,
					) {
						Text("Refresh")
					}
				}
			}
		}
		RawField(edit, Modifier.weight(1f)) {
			// A notice describes the text it answered, not what was typed after.
			notice = null
			ops.type(target, edit.path, it)
		}
		notice?.let { WorkspaceNotice(it) }
		if (edit.edited) {
			Row(
				Modifier.fillMaxWidth().padding(12.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
			) {
				OutlinedButton(
					onClick = hapticClick {
						notice = null
						ops.discard(target, edit.path)
					},
					enabled = !busy,
					modifier = Modifier.weight(1f),
				) {
					Text("Discard")
				}
				Button(
					onClick = hapticClick { submit { notice = rawSaveNotice(ops.save(target, edit.path)) } },
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
			// A caret move is not typing.
			val typed = it.text != value.text
			value = it
			if (typed) onType(it.text)
		},
		modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
		textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
		colors = OutlinedTextFieldDefaults.colors(
			focusedBorderColor = MaterialTheme.colorScheme.primary,
			unfocusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.4f),
		),
	)
}
