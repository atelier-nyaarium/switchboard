package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/** A record page's removal: the top bar's menu, then `ConfirmDialog`. */
@Composable
fun RemoveMenu(label: String, enabled: Boolean = true, onPick: () -> Unit) {
	var open by remember { mutableStateOf(false) }
	Box {
		IconButton(onClick = hapticClick { open = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More") }
		DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
			DropdownMenuItem(
				text = { Text(label, color = MaterialTheme.colorScheme.error) },
				enabled = enabled,
				onClick = {
					open = false
					onPick()
				},
			)
		}
	}
}
