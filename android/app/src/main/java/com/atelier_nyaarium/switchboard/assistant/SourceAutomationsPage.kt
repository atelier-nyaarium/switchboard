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

@Composable
internal fun SourceAutomationsPage(title: String, uses: UsedBy, onBack: () -> Unit) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	AssistantPageScaffold(title, onBack) {
		when (uses) {
			is UsedBy.Empty ->
				if (uses.why == ListEmpty.Reading) CircularProgressIndicator()
				else Text(emptyLine(uses.why, "automations"), style = MaterialTheme.typography.bodyLarge, color = dim)
			is UsedBy.Rows -> for (row in uses.rows) {
				Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
					Text(row.sentence, style = MaterialTheme.typography.bodyLarge)
					row.invalid?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
				}
			}
		}
	}
}
