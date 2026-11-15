package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ListEmpty
import com.atelier_nyaarium.switchboard.emptyLine
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger

/** The rows one source's events trigger. */
internal fun triggeredBy(sourceId: String, rows: List<AutomationRow>): List<AutomationRow> =
	rows.filter { (it.automation.trigger as? AutomationTrigger.Event)?.source == sourceId }

/** Null rows: still reading. */
@Composable
internal fun SourceAutomationsPage(title: String, rows: List<AutomationRow>?, onBack: () -> Unit) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	AssistantPageScaffold(title, onBack) {
		when {
			rows == null -> CircularProgressIndicator()
			rows.isEmpty() -> Text(emptyLine(ListEmpty.None, "automations"), style = MaterialTheme.typography.bodyLarge, color = dim)
			else -> for (row in rows) {
				Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
					Text(row.sentence, style = MaterialTheme.typography.bodyLarge)
					row.invalid?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
				}
			}
		}
	}
}
