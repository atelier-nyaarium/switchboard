package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/** A waiting permission prompt, inline at the top of its conversation. */
@Composable
internal fun SessionApprovalPanel(
	view: ApprovalView,
	onApprove: (promptId: String) -> Unit,
	onDeny: (promptId: String, reason: String) -> Unit,
) {
	var denying by rememberSaveable(view.promptId) { mutableStateOf(false) }
	var reason by rememberSaveable(view.promptId) { mutableStateOf("") }
	val red = presenceColor(SessionWord.NEEDS_APPROVAL)
	Column(
		Modifier
			.fillMaxWidth()
			.padding(horizontal = 12.dp, vertical = 6.dp)
			.background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp))
			.border(1.dp, red.copy(alpha = 0.55f), RoundedCornerShape(16.dp))
			.padding(horizontal = 14.dp, vertical = 12.dp),
	) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.size(8.dp).clip(CircleShape).background(red))
			Spacer(Modifier.width(8.dp))
			Text("Needs approval", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		val prompt = view.prompt
		if (prompt == null) {
			Text(
				"Reading the prompt...",
				Modifier.padding(top = 8.dp),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		} else {
			Text(prompt.title, Modifier.padding(top = 4.dp), style = MaterialTheme.typography.titleSmall)
			if (prompt.body.isNotEmpty()) {
				Box(
					Modifier
						.padding(top = 8.dp)
						.fillMaxWidth()
						.heightIn(max = 160.dp)
						.background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(10.dp))
						.verticalScroll(rememberScrollState())
						.horizontalScroll(rememberScrollState())
						.padding(horizontal = 10.dp, vertical = 8.dp),
				) {
					Text(prompt.body.joinToString("\n"), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
				}
			}
		}
		if (denying) {
			OutlinedTextField(
				value = reason,
				onValueChange = { reason = it },
				label = { Text("Tell Claude what to do instead") },
				modifier = Modifier.padding(top = 12.dp).fillMaxWidth(),
				enabled = !view.sending,
			)
		}
		view.failure?.let {
			Text(
				it,
				Modifier.padding(top = 8.dp),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.error,
			)
		}
		Row(
			Modifier.padding(top = 12.dp).fillMaxWidth(),
			horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
		) {
			if (denying) {
				TextButton(onClick = { denying = false }, enabled = !view.sending) { Text("Back") }
				Button(onClick = { onDeny(view.promptId, reason) }, enabled = denyReady(view, reason)) { Text("Deny") }
			} else {
				OutlinedButton(onClick = { denying = true }, enabled = view.answerable) { Text("Deny") }
				Button(onClick = { onApprove(view.promptId) }, enabled = view.answerable) { Text("Approve") }
			}
		}
	}
}
