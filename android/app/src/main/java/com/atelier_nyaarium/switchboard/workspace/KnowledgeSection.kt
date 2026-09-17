package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AskOps
import com.atelier_nyaarium.switchboard.AskProgress
import com.atelier_nyaarium.switchboard.AskRow
import com.atelier_nyaarium.switchboard.AskSubject
import com.atelier_nyaarium.switchboard.AskedKey
import com.atelier_nyaarium.switchboard.AskedLookup
import com.atelier_nyaarium.switchboard.ProgressRow
import com.atelier_nyaarium.switchboard.RowWord
import com.atelier_nyaarium.switchboard.ScopeKey
import com.atelier_nyaarium.switchboard.askRows
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.knowledgeRows
import com.atelier_nyaarium.switchboard.listedScope
import com.atelier_nyaarium.switchboard.pageScope
import com.atelier_nyaarium.switchboard.pageSend
import com.atelier_nyaarium.switchboard.progressLine
import com.atelier_nyaarium.switchboard.progressOf
import com.atelier_nyaarium.switchboard.progressText
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.readTarget
import com.atelier_nyaarium.switchboard.recordedText
import com.atelier_nyaarium.switchboard.rowWordText
import kotlinx.coroutines.delay

/** The age line is minutes, so a minute is as often as it can change. */
private const val PROGRESS_TICK_MS = 60_000L

/** A pair still out, on a question row and on a progress row. */
private val ASKED_TINT = Color(0xFFD9C28A)

private val PROGRESS_ASKED_TINT = Color(0xFF6F6A76)

private val RECORDED_TINT = Color(0xFF7EE787)

/**
 * A symbol's knowledge: how much of it is recorded, what a send left out, and the rows an Ask opens
 * from. Progress is read back from Lexicon through the scope this page keeps, never from a reply.
 */
@Composable
internal fun KnowledgeSection(
	ops: AskOps,
	subject: AskSubject,
	answer: WorkspaceKnowledgeAnswer,
	now: () -> Long,
	onAsk: (String?) -> Unit,
) {
	val views by ops.scopeViews.collectAsState()
	val sends by ops.store.sends.collectAsState()
	// Sticky: dropping it when the kept scope changes would switch the page straight back again.
	var root by remember(subject.target.key, subject.symbolId) { mutableStateOf<String?>(null) }
	val send = remember(sends, root, subject) {
		root?.let { at -> pageSend(subject) { ops.store.latestFor(subject.target.address, at, it) } }
	}
	val key = remember(subject, send) { ScopeKey(subject.target, readTarget(subject, pageScope(subject, send)), false) }
	LaunchedEffect(key) { ops.keepScope(key) }
	val read = listedScope(views, key)
	LaunchedEffect(read?.root) { read?.root?.let { root = it } }
	val entry = read?.symbols?.firstOrNull { it.symbolId == subject.symbolId }
	val asked = AskedLookup { id, question ->
		root?.let { ops.store.outstanding(AskedKey(subject.target.address, it, id, question)) } == true
	}
	val rows = remember(answer, entry, sends, root) {
		knowledgeRows(answer)?.let { askRows(it, subject.symbolId, entry, asked) }
	}
	val at by produceState(now(), send) {
		while (true) {
			value = now()
			delay(PROGRESS_TICK_MS)
		}
	}
	val progress = remember(send, read, at) { progressOf(send, read, at) }

	Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		KnowledgeHeader(recordedText(entry?.questions, answer.answers)) { onAsk(null) }
		progress?.let { ProgressBlock(it, at) }
		if (rows == null) {
			WorkspaceNotice("Update this session's plugin to see what Lexicon knows")
		} else {
			for (row in rows) QuestionCard(row) { onAsk(row.question) }
		}
	}
}

@Composable
private fun KnowledgeHeader(recorded: String, onAsk: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(end = 12.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		FacetSection("Knowledge")
		Text(
			recorded,
			Modifier.weight(1f),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Button(
			onClick = hapticClick(onAsk),
			modifier = Modifier.height(32.dp),
			contentPadding = PaddingValues(horizontal = 18.dp),
		) {
			Text("Ask", style = MaterialTheme.typography.labelMedium)
		}
	}
}

@Composable
private fun ProgressBlock(progress: AskProgress, now: Long) {
	Column(
		Modifier.fillMaxWidth().padding(horizontal = 14.dp),
		verticalArrangement = Arrangement.spacedBy(6.dp),
	) {
		LinearProgressIndicator(
			progress = { if (progress.sent == 0) 0f else progress.recorded.toFloat() / progress.sent },
			modifier = Modifier.fillMaxWidth(),
		)
		Text(
			progressText(progress, now),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.primary,
		)
		if (!progress.oneSymbol) for (row in progress.rows) ProgressRowLine(row)
	}
}

@Composable
private fun ProgressRowLine(row: ProgressRow) {
	val line = progressLine(row)
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Text(
			row.name,
			Modifier.weight(1f),
			style = MaterialTheme.typography.labelSmall,
			fontFamily = FontFamily.Monospace,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
		)
		Text(
			line.text,
			style = MaterialTheme.typography.labelSmall,
			color = if (line.word == RowWord.RECORDED) RECORDED_TINT else PROGRESS_ASKED_TINT,
		)
	}
}

@Composable
private fun QuestionCard(row: AskRow, onAsk: () -> Unit) {
	val colors = MaterialTheme.colorScheme
	val opens = row.word != RowWord.RECORDED
	OutlinedCard(
		Modifier.fillMaxWidth().padding(horizontal = 12.dp)
			.let { if (!opens) it else it.clickable(onClick = hapticClick(onAsk)) },
	) {
		Column(
			Modifier.padding(horizontal = 12.dp, vertical = if (row.prose == null) 6.dp else 12.dp),
			verticalArrangement = Arrangement.spacedBy(6.dp),
		) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(
					row.question.uppercase(),
					style = MaterialTheme.typography.labelMedium,
					fontWeight = FontWeight.SemiBold,
					color = if (opens) colors.onSurfaceVariant else colors.primary,
				)
				Text(
					rowWordText(row.word),
					Modifier.weight(1f),
					style = MaterialTheme.typography.labelSmall,
					color = when (row.word) {
						RowWord.ASKED -> ASKED_TINT
						RowWord.RECORDED -> RECORDED_TINT
						RowWord.NOT_RECORDED -> colors.onSurfaceVariant
					},
				)
				for (badge in row.badges) BadgeLabel(badge)
				if (opens) Chevron()
			}
			row.prose?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
		}
	}
}
