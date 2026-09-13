package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.KnowledgeBadge
import com.atelier_nyaarium.switchboard.KnowledgeRow
import com.atelier_nyaarium.switchboard.RequestState
import com.atelier_nyaarium.switchboard.askLabel
import com.atelier_nyaarium.switchboard.askable
import com.atelier_nyaarium.switchboard.knowledgeRequest
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.knowledgeFacts
import com.atelier_nyaarium.switchboard.knowledgeRows
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolSourceAnswer
import com.atelier_nyaarium.switchboard.spanLines
import kotlinx.coroutines.launch

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
	val requests by ops.requestStates.collectAsState()
	val scope = rememberCoroutineScope()
	LaunchedEffect(target.key, symbolId) { source = ops.symbol(target, symbolId) }
	LaunchedEffect(target.key, symbolId) { knowledge = ops.knowledge(target, symbolId) }
	val known = (knowledge as? WorkspaceAnswer.Read)?.value
	val span = (source as? WorkspaceAnswer.Read)?.value

	Column(modifier.fillMaxSize()) {
		Column(
			Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
			verticalArrangement = Arrangement.spacedBy(10.dp),
		) {
			SymbolHeader(span, known)
			WorkspaceAnswerBox(source) { read ->
				val lines = spanLines(read)
				var whole by remember(read.symbolId) { mutableStateOf(false) }
				Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
			WorkspaceAnswerBox(knowledge) { answer ->
				val rows = knowledgeRows(answer)
				Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
					answer.documentation?.let { doc ->
						DetailSection("Documentation")
						OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
							Text(doc, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
						}
					}
					DetailSection("Knowledge")
					if (rows == null) {
						WorkspaceNotice("Update this session's plugin to see what Lexicon knows")
					} else {
						for (row in rows) {
							val state = requests[knowledgeRequest(target, answer.symbolId, row.question)]
							KnowledgeCard(
								row = row,
								state = state,
								onAsk = { scope.launch { ops.askKnowledge(target, answer, row.question) } },
							)
						}
					}
					answer.facts?.let { facts ->
						DetailSection("Facts")
						OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
							for (fact in knowledgeFacts(facts)) {
								Row(
									Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
									verticalAlignment = Alignment.CenterVertically,
								) {
									Text(fact.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
									Text(
										"${fact.count}",
										style = MaterialTheme.typography.labelMedium,
										fontFamily = FontFamily.Monospace,
										color = MaterialTheme.colorScheme.onSurfaceVariant,
									)
								}
							}
						}
					}
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
private fun SymbolHeader(span: WorkspaceSymbolSourceAnswer?, known: WorkspaceKnowledgeAnswer?) {
	val name = span?.name ?: known?.name ?: return
	Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			KindBadge(known?.symbolKind)
			Text(name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
		}
		val module = span?.module ?: known?.module
		val start = span?.startLine ?: known?.startLine
		val end = span?.endLine ?: known?.endLine
		if (module != null) {
			Text(
				if (start != null && end != null) "$module : $start-$end" else module,
				style = MaterialTheme.typography.labelSmall,
				fontFamily = FontFamily.Monospace,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

@Composable
private fun KnowledgeCard(row: KnowledgeRow, state: RequestState?, onAsk: () -> Unit) {
	OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
		Column(
			Modifier.padding(horizontal = 12.dp, vertical = if (row.prose == null) 6.dp else 12.dp),
			verticalArrangement = Arrangement.spacedBy(6.dp),
		) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(
					row.question.uppercase(),
					style = MaterialTheme.typography.labelMedium,
					fontWeight = FontWeight.SemiBold,
					color = if (row.prose == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
				)
				if (row.prose == null) {
					Text(
						"not recorded",
						Modifier.weight(1f),
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
					OutlinedButton(
						onClick = hapticClick(onAsk),
						enabled = askable(state),
						modifier = Modifier.height(32.dp),
						contentPadding = PaddingValues(horizontal = 14.dp),
					) {
						Text(askLabel(state), style = MaterialTheme.typography.labelMedium)
					}
				} else {
					Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
						for (badge in row.badges) BadgeLabel(badge)
					}
				}
			}
			row.prose?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
		}
	}
}

@Composable
private fun BadgeLabel(badge: KnowledgeBadge) {
	val colors = MaterialTheme.colorScheme
	Text(
		badge.name,
		Modifier.padding(start = 6.dp),
		style = MaterialTheme.typography.labelSmall,
		fontFamily = FontFamily.Monospace,
		color = if (badge == KnowledgeBadge.THIN) colors.onSurfaceVariant else colors.error,
	)
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
