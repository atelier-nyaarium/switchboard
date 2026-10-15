package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.noteBadges
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeNote

/** The symbol's Lexicon note, read only. */
@Composable
internal fun NoteSection(note: WorkspaceKnowledgeNote) {
	val badges = remember(note) { noteBadges(note) }
	val text = remember(note) { inlineCodeAnnotated(note.text) }
	Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		FacetSection("Note")
		OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
			Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
				if (badges.isNotEmpty()) FlowRow { for (badge in badges) BadgeLabel(badge) }
				Text(text, style = MaterialTheme.typography.bodySmall)
			}
		}
	}
}
