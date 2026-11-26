package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.ScrollState
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
	onBack: () -> Unit,
	/** Non-null while Back asked. */
	leaving: LeaveAsking? = null,
	/** Drawn after Save. */
	menu: @Composable RowScope.() -> Unit = {},
	scrollState: ScrollState? = null,
	content: @Composable ColumnScope.() -> Unit,
) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(title) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
				actions = {
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
			Modifier.padding(pad).fillMaxSize().imePadding().verticalScroll(scrollState ?: rememberScrollState())
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
	val leaving: LeaveAsking?,
)

/** Null draws nothing, or [unopened] without a draft. */
@Composable
internal fun <K : Any, D : Any, S : Any> rememberEdit(
	edits: EditorSessions<K, D, S>,
	key: K,
	standing: EditStanding,
	opened: D?,
	unopened: @Composable (EditStanding) -> Unit,
): OpenEdit<D, S>? {
	val state by edits.state.collectAsState()
	LaunchedEffect(key, standing, opened) {
		if (standing == EditStanding.READY && opened != null) edits.open(key, opened)
	}
	if (state.shown != key) return null
	val session = state.held[key]
	if (session == null) {
		if (standing != EditStanding.READY || opened == null) unopened(standing)
		return null
	}
	val close = { edits.discard(key, session.opening) }
	return OpenEdit(session.opening, session, LeaveAsking(edits::stay, close).takeIf { state.asks(key) })
}

/** An editor whose record is unread or gone. */
@Composable
internal fun EditorWaiting(title: String, standing: EditStanding, onBack: () -> Unit) {
	EditorScaffold(title = title, saving = false, canSave = false, onSave = {}, onBack = onBack) {
		waitingLine(standing)?.let { Text(it, style = MaterialTheme.typography.bodyLarge) } ?: CircularProgressIndicator()
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
