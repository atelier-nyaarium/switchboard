package com.atelier_nyaarium.switchboard.vault

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** What the conversation needs to draw a waiting request, assembled where repo and state are held. */
data class VaultTile(
	val requestId: String,
	val title: String,
	val requester: String,
	val operation: String,
	val deadlineAt: Long,
)

/**
 * A waiting request, shown in the thread it came from whenever the overlay prompt is not drawing
 * it. Without the overlay grant that is always, which makes this the only surface that names a
 * request in the session that asked for it.
 */
@Composable
fun VaultRequestTile(tile: VaultTile, onOpen: () -> Unit) {
	var now by remember(tile.requestId) { mutableLongStateOf(System.currentTimeMillis()) }
	LaunchedEffect(tile.requestId) {
		while (true) {
			delay(15_000)
			now = System.currentTimeMillis()
		}
	}
	val expiry = expiresIn(tile.deadlineAt, now)
	Column(
		Modifier
			.fillMaxWidth()
			.padding(horizontal = 12.dp, vertical = 6.dp)
			.background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp))
			.clickable { onOpen() }
			.padding(horizontal = 14.dp, vertical = 12.dp),
	) {
		Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
			Text(
				tile.title,
				Modifier.weight(1f),
				style = MaterialTheme.typography.titleSmall,
				fontWeight = FontWeight.Bold,
			)
			Text(
				expiry.text,
				style = MaterialTheme.typography.labelSmall,
				color = if (expiry.urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		Text(
			tile.requester,
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Text(
			tile.operation,
			Modifier
				.padding(top = 8.dp)
				.fillMaxWidth()
				.background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(10.dp))
				.padding(horizontal = 10.dp, vertical = 8.dp),
			style = MaterialTheme.typography.bodySmall,
			fontFamily = FontFamily.Monospace,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
		)
	}
}
