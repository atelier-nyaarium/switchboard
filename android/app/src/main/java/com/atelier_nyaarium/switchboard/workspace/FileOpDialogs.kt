package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.FileAction
import com.atelier_nyaarium.switchboard.FileOpConfirm
import com.atelier_nyaarium.switchboard.PathAsk
import com.atelier_nyaarium.switchboard.hapticClick

@Composable
internal fun PathDialog(ask: PathAsk, onChosen: (FileAction) -> Unit, onDismiss: () -> Unit) {
	var typed by remember(ask) { mutableStateOf(TextFieldValue(ask.prefill, TextRange(ask.prefill.length))) }
	val focus = remember { FocusRequester() }
	val action = ask.actionOf(typed.text)
	LaunchedEffect(ask) { focus.requestFocus() }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(ask.title) },
		text = {
			OutlinedTextField(
				value = typed,
				onValueChange = { typed = it },
				modifier = Modifier.focusRequester(focus),
				singleLine = true,
				textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
			)
		},
		confirmButton = {
			TextButton(onClick = hapticClick { action?.let(onChosen) }, enabled = action != null) {
				Text(if (ask.kind == PathAsk.Kind.Create) "Create" else "Next")
			}
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

@Composable
internal fun ConfirmFileOpDialog(confirm: FileOpConfirm, onConfirm: () -> Unit, onDismiss: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(confirm.title) },
		text = if (confirm.lines.isEmpty()) {
			null
		} else {
			{
				Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
					for (line in confirm.lines) Text(line, style = MaterialTheme.typography.bodyMedium)
				}
			}
		},
		confirmButton = {
			TextButton(onClick = hapticClick(onConfirm)) {
				Text(confirm.button, color = MaterialTheme.colorScheme.error)
			}
		},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}
