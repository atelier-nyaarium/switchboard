package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.addGroups
import com.atelier_nyaarium.switchboard.groupTitle
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Integration

@Composable
internal fun IntegrationAddPage(state: ChatState, home: String, onEntry: (String, String) -> Unit, onBack: () -> Unit) {
	val offered = state.gateways.assistantOn(home)?.offered
	var query by rememberSaveable(home) { mutableStateOf("") }
	val groups = remember(offered, query) { addGroups(offered, query) }

	AssistantPageScaffold("Add", onBack) {
		OutlinedTextField(
			value = query,
			onValueChange = { query = it },
			placeholder = { Text("Search") },
			leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
			singleLine = true,
			modifier = Modifier.fillMaxWidth(),
		)
		if (groups.isEmpty()) {
			Text(
				if (offered == null) "This Gateway offers nothing to add" else "Nothing matches",
				style = MaterialTheme.typography.bodyMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
		groups.forEachIndexed { at, group ->
			if (at > 0) HorizontalDivider()
			Text(groupTitle(group.group), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			for (entry in group.entries) EntryRow(entry) { onEntry(home, entry.id) }
		}
	}
}

@Composable
private fun EntryRow(entry: Integration, onOpen: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onOpen)).padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(entry.label, style = MaterialTheme.typography.bodyLarge)
			Text(entry.blurb, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}
