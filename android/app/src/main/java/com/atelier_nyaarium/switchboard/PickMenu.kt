package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.atelier_nyaarium.switchboard.hapticClick

/** Field and rows share one label. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun <T> PickMenu(
	label: String,
	choices: List<T>,
	picked: T?,
	labelOf: (T) -> String,
	onPick: (T) -> Unit,
	trailingOf: (T) -> String? = { null },
) {
	var open by remember { mutableStateOf(false) }

	ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = Modifier.fillMaxWidth()) {
		OutlinedTextField(
			value = picked?.let(labelOf) ?: "",
			onValueChange = {},
			readOnly = true,
			label = { Text(label) },
			placeholder = { Text(if (choices.isEmpty()) "Nothing to pick" else "Choose one") },
			trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
			modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
		)
		ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			for (choice in choices) {
				DropdownMenuItem(
					text = { Text(labelOf(choice)) },
					trailingIcon = trailingOf(choice)?.let { note ->
						{
							Text(
								note,
								style = MaterialTheme.typography.labelSmall,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
					},
					onClick = hapticClick {
						onPick(choice)
						open = false
					},
				)
			}
		}
	}
}
