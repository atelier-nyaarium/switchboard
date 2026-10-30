package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.InboxRow
import com.atelier_nyaarium.switchboard.PageWork
import com.atelier_nyaarium.switchboard.hapticClick

/** Pinned under the top bar. */
@Composable
internal fun InboxStrip(
	rows: List<InboxRow>,
	work: (InboxRow) -> PageWork,
	onCheck: (String) -> Unit,
	onSettings: (String) -> Unit,
) {
	if (rows.isEmpty()) return
	var expanded by rememberSaveable { mutableStateOf(true) }
	Surface(tonalElevation = 2.dp) {
		Column(Modifier.fillMaxWidth().padding(bottom = if (expanded) 6.dp else 0.dp)) {
			Row(
				Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 14.dp, vertical = 8.dp),
				horizontalArrangement = Arrangement.spacedBy(9.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Icon(
					if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight,
					contentDescription = if (expanded) "Collapse" else "Expand",
					tint = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.size(18.dp),
				)
				Text("Inbox", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
			}
			if (expanded) {
				for (row in rows) InboxStripRow(row, work(row), onCheck, onSettings)
			}
		}
	}
}

@Composable
private fun InboxStripRow(row: InboxRow, work: PageWork, onCheck: (String) -> Unit, onSettings: (String) -> Unit) {
	Column(Modifier.fillMaxWidth().padding(start = 41.dp, end = 14.dp)) {
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			if (row is InboxRow.Problem) {
				Icon(
					Icons.Default.Warning,
					contentDescription = "Needs attention",
					tint = MaterialTheme.colorScheme.error,
					modifier = Modifier.size(16.dp),
				)
			}
			Text(
				row.label,
				style = MaterialTheme.typography.bodyMedium,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
				modifier = Modifier.weight(1f),
			)
			when (row) {
				is InboxRow.Waiting -> {
					Text(
						row.badge,
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSecondaryContainer,
						modifier = Modifier
							.clip(RoundedCornerShape(10.dp))
							.background(MaterialTheme.colorScheme.secondaryContainer)
							.padding(horizontal = 8.dp, vertical = 2.dp),
					)
					if (work.busy) {
						CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
					} else {
						Button(onClick = hapticClick { onCheck(row.watcherId) }) { Text("Check now") }
					}
				}
				is InboxRow.Problem -> OutlinedButton(onClick = hapticClick { onSettings(row.watcherId) }) { Text("Settings") }
			}
		}
		work.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
	}
}
