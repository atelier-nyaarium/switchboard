package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * The one full-screen record editor: its bar, its Save rule, and its scrolling body. The keyboard
 * inset lives here because it was missing from every editor at once when each owned its own.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScaffold(
	title: String,
	saving: Boolean,
	canSave: Boolean,
	onCancel: () -> Unit,
	onSave: () -> Unit,
	content: @Composable ColumnScope.() -> Unit,
) {
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(title) },
				actions = {
					TextButton(onClick = hapticClick(onCancel)) { Text("Cancel") }
					Button(
						enabled = canSave && !saving,
						onClick = hapticClick(onSave),
						modifier = Modifier.padding(end = 8.dp),
					) { Text(if (saving) "Saving" else "Save") }
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
}
