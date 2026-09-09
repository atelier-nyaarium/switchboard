package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * A new record belongs to the Gateway that holds it, and no Gateway is the default one. One is taken
 * without asking; several are asked. No Gateway means no button, since a tap could do nothing.
 */
@Composable
fun NewOnGatewayFab(
	gateways: List<String>,
	description: String,
	onNew: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	var picking by remember { mutableStateOf(false) }
	if (gateways.isEmpty()) return

	FloatingActionButton(
		onClick = hapticClick { if (gateways.size > 1) picking = true else onNew(gateways.first()) },
		modifier = modifier,
	) { Icon(Icons.Default.Add, contentDescription = description) }

	if (picking) {
		AlertDialog(
			onDismissRequest = { picking = false },
			title = { Text("Which Gateway") },
			text = {
				Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
					for (gatewayId in gateways) {
						TextButton(
							onClick = hapticClick {
								picking = false
								onNew(gatewayId)
							},
						) { Text(gatewayId) }
					}
				}
			},
			confirmButton = {},
			dismissButton = { TextButton(onClick = hapticClick { picking = false }) { Text("Cancel") } },
		)
	}
}
