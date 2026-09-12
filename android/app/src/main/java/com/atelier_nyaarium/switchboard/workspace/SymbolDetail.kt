package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.spanLines

private const val SOURCE_PREVIEW_LINES = 40

/**
 * One symbol: its source, and what Lexicon knows about it. Two reads rather than one, so the source
 * still draws when the knowledge read is refused or the index has nothing recorded.
 */
@Composable
internal fun SymbolDetail(
	ops: WindowOps,
	target: WorkspaceTarget,
	symbolId: String,
	onOpenWindow: () -> Unit,
	modifier: Modifier = Modifier,
) {
	var source by remember(target.key, symbolId) {
		mutableStateOf<WorkspaceAnswer<WorkspaceSymbolSourceAnswer>?>(null)
	}
	var knowledge by remember(target.key, symbolId) {
		mutableStateOf<WorkspaceAnswer<WorkspaceKnowledgeAnswer>?>(null)
	}
	LaunchedEffect(target.key, symbolId) { source = ops.symbol(target, symbolId) }
	LaunchedEffect(target.key, symbolId) { knowledge = ops.knowledge(target, symbolId) }

	Column(modifier.fillMaxSize()) {
		Column(
			Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(10.dp),
		) {
			WorkspaceAnswerBox(source) { span ->
				val lines = spanLines(span)
				var whole by remember(span.symbolId) { mutableStateOf(false) }
				Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
					Text(
						"${span.module} : ${span.startLine}-${span.endLine}",
						Modifier.padding(horizontal = 12.dp),
						style = MaterialTheme.typography.labelSmall,
						fontFamily = FontFamily.Monospace,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					DetailSection("Source")
					OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
						// Capped until asked, or a long declaration builds thousands of rows to be read past.
						CodeLines(if (whole) lines else lines.take(SOURCE_PREVIEW_LINES), Modifier.padding(vertical = 6.dp))
						if (!whole && lines.size > SOURCE_PREVIEW_LINES) {
							TextButton(onClick = hapticClick { whole = true }, modifier = Modifier.padding(start = 4.dp)) {
								Text("Show all ${lines.size} lines")
							}
						}
					}
				}
			}
			DetailSection("Knowledge")
			WorkspaceAnswerBox(knowledge) { known ->
				OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
					Text(
						known.text.ifBlank { "Nothing recorded" },
						Modifier.padding(12.dp),
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}
		}
		Button(
			onClick = hapticClick(onOpenWindow),
			modifier = Modifier.fillMaxWidth().padding(12.dp),
			enabled = source is WorkspaceAnswer.Read,
		) {
			Text("Open Window")
		}
	}
}

@Composable
private fun DetailSection(title: String) {
	Text(
		title,
		Modifier.padding(horizontal = 12.dp),
		style = MaterialTheme.typography.labelMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}
