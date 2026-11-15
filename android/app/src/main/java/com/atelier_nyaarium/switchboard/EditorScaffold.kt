package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** What a changed draft's Back shows. */
internal class LeaveAsking(val onStay: () -> Unit, val onDiscard: () -> Unit)

/**
 * The one full-screen record editor: bar, Save rule, scrolling body, the keyboard inset, and the
 * leave dialogue.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun EditorScaffold(
	title: String,
	saving: Boolean,
	canSave: Boolean,
	onSave: () -> Unit,
	/** The arrow; asks on a changed draft. */
	onBack: (() -> Unit)? = null,
	/** Discards at once. */
	onCancel: (() -> Unit)? = null,
	/** Non-null while Back asked. */
	leaving: LeaveAsking? = null,
	/** Drawn after Save. */
	menu: @Composable RowScope.() -> Unit = {},
	content: @Composable ColumnScope.() -> Unit,
) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(title) },
				navigationIcon = {
					if (onBack != null) {
						IconButton(onClick = hapticClick(onBack)) {
							Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
						}
					}
				},
				actions = {
					// A save out would be refused unheard.
					if (onCancel != null) TextButton(enabled = !saving, onClick = hapticClick(onCancel)) { Text("Cancel") }
					Button(
						enabled = canSave && !saving,
						onClick = hapticClick(onSave),
						modifier = Modifier.padding(end = 8.dp),
					) { Text(if (saving) "Saving" else "Save") }
					menu()
				},
			)
		},
	) { pad ->
		Column(
			Modifier.padding(pad).fillMaxSize().imePadding().verticalScroll(rememberScrollState())
				.padding(horizontal = 16.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
			content = content,
		)
	}
	leaving?.let { LeaveDialog(it.onStay, it.onDiscard) }
}

/** An editor's hold on its session. */
internal class OpenEdit<D, S>(
	val opening: Long,
	val session: EditSession<D, S>,
	/** Discards and closes. */
	val close: () -> Unit,
	val leaving: LeaveAsking?,
)

/** Null draws nothing, or the waiting page. */
@Composable
internal fun <D : Any, S : Any> rememberEdit(
	edits: EditorSessions<EditKey, D, S>,
	key: EditKey,
	standing: EditStanding,
	title: String,
	onClose: () -> Unit,
	initial: () -> D,
): OpenEdit<D, S>? {
	val sessions by edits.held.collectAsState()
	val leaving by edits.leaving.collectAsState()
	var opening by remember(key) { mutableStateOf<Long?>(null) }
	LaunchedEffect(key, standing) {
		if (opening == null && standing == EditStanding.READY) opening = edits.open(key, initial())
	}
	val shown = opening
	val latest = rememberUpdatedState(shown)
	DisposableEffect(key) { onDispose { latest.value?.let { edits.park(key, it) } } }
	val showing = editorShowing(shown, sessions[key])
	LaunchedEffect(showing) { if (showing == EditorShowing.CLOSING) onClose() }
	val session = sessions[key]
	if (shown == null || session == null || showing != EditorShowing.DRAWN) {
		if (shown == null && standing != EditStanding.READY) EditorWaiting(title, standing == EditStanding.GONE, onClose)
		return null
	}
	val close = {
		edits.discard(key, shown)
		onClose()
	}
	return OpenEdit(shown, session, close, LeaveAsking(edits::stay, close).takeIf { leaveShown(leaving, key, session) })
}

/** An editor whose record is unread or gone. */
@Composable
private fun EditorWaiting(title: String, gone: Boolean, onClose: () -> Unit) {
	EditorScaffold(title = title, saving = false, canSave = false, onSave = {}, onCancel = onClose) {
		if (gone) Text("Deleted elsewhere.", style = MaterialTheme.typography.bodyLarge) else CircularProgressIndicator()
	}
}

@Composable
internal fun LeaveDialog(onStay: () -> Unit, onDiscard: () -> Unit) {
	AlertDialog(
		onDismissRequest = onStay,
		title = { Text("Leave and discard changes?") },
		text = { Text("Changes have not been saved.") },
		confirmButton = { TextButton(onClick = hapticClick(onStay)) { Text("Stay") } },
		dismissButton = {
			TextButton(onClick = hapticClick(onDiscard)) { Text("Discard", color = MaterialTheme.colorScheme.error) }
		},
	)
}
