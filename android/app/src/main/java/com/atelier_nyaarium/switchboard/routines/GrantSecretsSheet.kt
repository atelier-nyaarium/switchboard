package com.atelier_nyaarium.switchboard.routines

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.vault.VaultEntryView

/** Held order, then new picks; ghosts dropped. */
internal fun grantedAfter(previous: List<String>, chosen: Set<String>, entries: List<VaultEntryView>): List<String> {
	val known = entries.map { it.id }.toSet()
	val kept = previous.filter { it in chosen && it in known }
	val added = entries.map { it.id }.filter { it in chosen && it !in kept }
	return kept + added
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GrantSecretsSheet(
	entries: List<VaultEntryView>,
	granted: List<String>,
	onDone: (List<String>) -> Unit,
	onDismiss: () -> Unit,
) {
	var query by remember { mutableStateOf("") }
	var chosen by remember { mutableStateOf(granted.toSet()) }
	val shown = remember(entries, query) { entries.filter { matchesSecret(it, query) } }

	ModalBottomSheet(onDismissRequest = onDismiss) {
		Column(
			Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text("Grant secrets", style = MaterialTheme.typography.titleLarge)

			OutlinedTextField(
				value = query,
				onValueChange = { query = it },
				placeholder = { Text("Filter by title or description") },
				singleLine = true,
				modifier = Modifier.fillMaxWidth(),
			)

			if (shown.isEmpty()) {
				Text(
					if (entries.isEmpty()) "Nothing in the vault yet." else "No secret matches \"${query.trim()}\"",
					style = MaterialTheme.typography.bodyMedium,
					modifier = Modifier.padding(vertical = 20.dp),
				)
			} else {
				LazyVerticalGrid(
					columns = GridCells.Fixed(2),
					modifier = Modifier.weight(1f, fill = false),
					horizontalArrangement = Arrangement.spacedBy(10.dp),
					verticalArrangement = Arrangement.spacedBy(10.dp),
				) {
					items(shown, key = { it.id }) { entry ->
						val on = entry.id in chosen
						Card(
							onClick = hapticClick { chosen = if (on) chosen - entry.id else chosen + entry.id },
							border = if (on) BorderStroke(1.dp, MaterialTheme.colorScheme.primary) else null,
							colors = if (on) {
								CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
							} else {
								CardDefaults.cardColors()
							},
						) {
							Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
								Row(verticalAlignment = Alignment.Top) {
									Text(
										entry.title,
										style = MaterialTheme.typography.titleSmall,
										maxLines = 2,
										overflow = TextOverflow.Ellipsis,
										modifier = Modifier.weight(1f),
									)
									if (on) {
										Icon(
											Icons.Filled.Check,
											contentDescription = "Granted",
											tint = MaterialTheme.colorScheme.primary,
											modifier = Modifier.size(18.dp),
										)
									}
								}
								entry.description?.let {
									Text(
										it,
										style = MaterialTheme.typography.bodySmall,
										color = MaterialTheme.colorScheme.onSurfaceVariant,
										maxLines = 3,
										overflow = TextOverflow.Ellipsis,
									)
								}
							}
						}
					}
				}
			}

			Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				TextButton(onClick = hapticClick(onDismiss), modifier = Modifier.weight(1f)) { Text("Cancel") }
				Button(
					onClick = hapticClick { onDone(grantedAfter(granted, chosen, entries)) },
					modifier = Modifier.weight(1f),
				) { Text("Done") }
			}
		}
	}
}
