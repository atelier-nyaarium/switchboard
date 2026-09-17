package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.DetailOpen
import com.atelier_nyaarium.switchboard.FacetKey
import com.atelier_nyaarium.switchboard.FacetState
import com.atelier_nyaarium.switchboard.SymbolViews
import com.atelier_nyaarium.switchboard.WorkspacePlace
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.commentsSubtitle
import com.atelier_nyaarium.switchboard.facetState
import com.atelier_nyaarium.switchboard.fileHistoryState
import com.atelier_nyaarium.switchboard.fileStrip
import com.atelier_nyaarium.switchboard.hierarchyColumn
import com.atelier_nyaarium.switchboard.historyBody
import com.atelier_nyaarium.switchboard.historySubtitle
import com.atelier_nyaarium.switchboard.membersSubtitle
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.targetsSubtitle
import com.atelier_nyaarium.switchboard.usesSubtitle

/** One drill-in: the read it draws, and the body its answer chooses. */
@Composable
internal fun FacetScreen(
	views: SymbolViews,
	target: WorkspaceTarget,
	place: WorkspacePlace.Facet,
	backTitle: String,
	now: () -> Long,
	onBack: () -> Unit,
	onOpen: (WorkspacePlace) -> Unit,
	modifier: Modifier = Modifier,
) {
	val shown by views.facetViews.collectAsState()
	val files by views.fileHistoryViews.collectAsState()
	val held = shown[FacetKey(target, place.symbolId, place.entry.facet)]?.answer
	val state = facetState(place.entry, place.symbolId, held)
	val answer = (state as? FacetState.Shown)?.value
	val open: (DetailOpen) -> Unit = { onOpen(WorkspacePlace.Detail(it.symbolId, it.module, it.name, it.reached)) }
	// Absent unless a keeper reads it, which only the history facet has.
	val file = (fileHistoryState(place.module, files[target to place.module]?.answer) as? FacetState.Shown)?.value
	val strip = remember(file) { file?.let { fileStrip(it, now()) } }

	Column(modifier.fillMaxSize()) {
		BackLine(backTitle, onBack)
		FacetHeader(place.entry.title, subOf(answer))
		HorizontalDivider()
		// Boxed, or a body that fills would measure past the header.
		Box(Modifier.weight(1f).fillMaxWidth()) {
			when (answer) {
				null -> FacetNotice(state)
				is WorkspaceFacetAnswer.Uses -> UsesList(answer, place.entry, open)
				is WorkspaceFacetAnswer.UsesFrom -> TargetsList(answer, open)
				is WorkspaceFacetAnswer.Members -> MembersList(answer, open)
				is WorkspaceFacetAnswer.Hierarchy -> HierarchyBody(remember(answer) { hierarchyColumn(answer) }, open)
				is WorkspaceFacetAnswer.Comments -> CommentsList(answer, open)
				is WorkspaceFacetAnswer.History -> HistoryBodyView(
					remember(answer) { historyBody(answer.outcome, answer.commits, answer.truncated, now()) },
					strip,
				)
			}
		}
	}
}

/** Nothing for an answer that arrived: the caller draws its body. */
@Composable
internal fun FacetNotice(state: FacetState<*>, modifier: Modifier = Modifier) {
	when (state) {
		FacetState.Loading -> Box(modifier.fillMaxWidth().padding(24.dp), Alignment.Center) { CircularProgressIndicator() }
		is FacetState.TooLarge -> OutlinedCard(modifier.fillMaxWidth().padding(12.dp)) {
			Column(Modifier.padding(12.dp)) {
				Text("Too large to list", style = MaterialTheme.typography.bodyMedium)
				Text(
					state.text,
					style = MaterialTheme.typography.labelMedium,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
		is FacetState.Refused -> WorkspaceNotice(state.text, modifier)
		FacetState.Unreachable -> WorkspaceNotice("This session could not be reached", modifier)
		is FacetState.Shown -> Unit
	}
}

private data class FacetSub(val text: String, val mono: Boolean = false)

private fun subOf(answer: WorkspaceFacetAnswer?): FacetSub? =
	when (answer) {
		null -> null
		is WorkspaceFacetAnswer.Uses -> FacetSub(usesSubtitle(answer.rows))
		is WorkspaceFacetAnswer.UsesFrom -> FacetSub(targetsSubtitle(answer.targets))
		is WorkspaceFacetAnswer.Members -> FacetSub(membersSubtitle(answer.members))
		is WorkspaceFacetAnswer.Hierarchy -> null
		is WorkspaceFacetAnswer.Comments -> FacetSub(commentsSubtitle(answer))
		is WorkspaceFacetAnswer.History ->
			FacetSub(historySubtitle(answer.module, answer.startLine, answer.endLine), mono = true)
	}

@Composable
private fun FacetHeader(title: String, sub: FacetSub?) {
	Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 10.dp)) {
		Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
		sub?.let {
			Text(
				it.text,
				style = MaterialTheme.typography.labelSmall,
				fontFamily = if (it.mono) FontFamily.Monospace else FontFamily.Default,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 2,
				overflow = TextOverflow.Ellipsis,
			)
		}
	}
}

/** The small caps label over a section, on the detail and on a drill-in alike. */
@Composable
internal fun FacetSection(title: String, modifier: Modifier = Modifier) {
	Text(
		title.uppercase(),
		modifier.padding(horizontal = 14.dp, vertical = 6.dp),
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}

/**
 * Cut at the front, since a path's tail names the file and the line. Ending the cut there leaves
 * every deep path reading as its first folders.
 */
@Composable
internal fun WhereLine(text: String, modifier: Modifier = Modifier) {
	Text(
		text,
		modifier,
		style = MaterialTheme.typography.labelSmall,
		fontFamily = FontFamily.Monospace,
		color = MaterialTheme.colorScheme.outline,
		maxLines = 1,
		overflow = TextOverflow.StartEllipsis,
	)
}

/** What a name the index does not hold is drawn in, rather than a solid card. */
internal fun Modifier.dashedOutline(color: Color): Modifier =
	drawBehind {
		drawRoundRect(
			color = color,
			cornerRadius = CornerRadius(10.dp.toPx()),
			style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 5f))),
		)
	}
