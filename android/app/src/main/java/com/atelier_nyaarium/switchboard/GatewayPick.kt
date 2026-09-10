package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * A new record belongs to the Gateway that holds it, and no Gateway is the default one. One is taken
 * without asking, several are asked, and none draws no button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewOnGatewayFab(
	registry: GatewayRegistry,
	description: String,
	onNew: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	var picking by remember { mutableStateOf(false) }
	// Only a Gateway the current roster can reach takes a new record.
	val offered = remember(registry) { registry.reachableIds().sorted() }
	if (offered.isEmpty()) return

	FloatingActionButton(
		onClick = hapticClick { if (offered.size > 1) picking = true else onNew(offered.first()) },
		modifier = modifier,
	) { Icon(Icons.Default.Add, contentDescription = description) }

	if (picking) {
		ModalBottomSheet(onDismissRequest = { picking = false }) {
			Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
				Text(
					"$description on",
					style = MaterialTheme.typography.titleMedium,
					modifier = Modifier.padding(horizontal = 16.dp),
				)
				for (gatewayId in offered) {
					ListItem(
						headlineContent = { Text(gatewayId) },
						leadingContent = { Icon(Icons.Default.Hub, contentDescription = null) },
						colors = ListItemDefaults.colors(containerColor = Color.Transparent),
						modifier = Modifier.clickable(
							onClick = hapticClick {
								picking = false
								onNew(gatewayId)
							},
						),
					)
				}
			}
		}
	}
}
