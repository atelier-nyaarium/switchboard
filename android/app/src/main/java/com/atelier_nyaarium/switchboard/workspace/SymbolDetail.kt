package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.CodePalette
import com.atelier_nyaarium.switchboard.DetailItem
import com.atelier_nyaarium.switchboard.DetailView
import com.atelier_nyaarium.switchboard.FacetEntry
import com.atelier_nyaarium.switchboard.FacetKey
import com.atelier_nyaarium.switchboard.FacetState
import com.atelier_nyaarium.switchboard.FacetSubject
import com.atelier_nyaarium.switchboard.FactRow
import com.atelier_nyaarium.switchboard.FactRows
import com.atelier_nyaarium.switchboard.KnowledgeBadge
import com.atelier_nyaarium.switchboard.KnowledgeRow
import com.atelier_nyaarium.switchboard.Reached
import com.atelier_nyaarium.switchboard.RequestKey
import com.atelier_nyaarium.switchboard.RequestState
import com.atelier_nyaarium.switchboard.RoleTone
import com.atelier_nyaarium.switchboard.SymbolIdentity
import com.atelier_nyaarium.switchboard.SymbolViews
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspacePlace
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.askLabel
import com.atelier_nyaarium.switchboard.askable
import com.atelier_nyaarium.switchboard.detailItems
import com.atelier_nyaarium.switchboard.facetState
import com.atelier_nyaarium.switchboard.factRows
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.knowledgeRequest
import com.atelier_nyaarium.switchboard.knowledgeRows
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.reachedIndex
import com.atelier_nyaarium.switchboard.whereText
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * One symbol: where it was reached from, what Lexicon counts about it, and its source. Separate
 * reads, so the source still draws when the knowledge read is refused.
 */
@Composable
internal fun SymbolDetail(
	views: SymbolViews,
	ops: WindowOps,
	target: WorkspaceTarget,
	place: WorkspacePlace.Detail,
	now: () -> Long,
	onOpen: (WorkspacePlace) -> Unit,
	onOpenWindow: () -> Unit,
	modifier: Modifier = Modifier,
) {
	val symbolId = place.symbolId
	val details by views.detailViews.collectAsState()
	val facets by views.facetViews.collectAsState()
	val view = details[target to symbolId] ?: DetailView()
	val history = facetState(FacetEntry.HISTORY, symbolId, facets[FacetKey(target, symbolId, WorkspaceFacet.History)]?.answer)
	val requests by ops.requestStates.collectAsState()
	val scope = rememberCoroutineScope()
	val listState = rememberLazyListState()
	var whole by rememberSaveable(symbolId) { mutableStateOf(false) }
	LaunchedEffect(target.key, symbolId) {
		coroutineScope {
			launch { views.keepDetail(target, symbolId) }
			views.keepFacet(target, symbolId, WorkspaceFacet.History)
		}
	}
	val items = remember(view, place.reached, whole) { detailItems(view, place.reached, whole) }
	val identity = view.identity
	val openFacet: (FacetEntry) -> Unit = { entry ->
		onOpen(
			WorkspacePlace.Facet(
				symbolId = symbolId,
				module = place.module,
				entry = entry,
				subject = FacetSubject(identity?.name ?: place.name, identity?.kind, identity?.startLine),
			),
		)
	}

	Column(modifier.fillMaxSize()) {
		LazyColumn(
			Modifier.weight(1f).fillMaxWidth(),
			state = listState,
			contentPadding = PaddingValues(bottom = 12.dp),
		) {
			for (row in items) {
				item(key = row.key) {
					when (row) {
						DetailItem.Header -> SymbolHeader(identity, place.name)
						is DetailItem.ReachedCard -> ReachedCard(row.reached) {
							reachedIndex(items)?.let { at -> scope.launch { listState.animateScrollToItem(at) } }
						}
						DetailItem.Facts -> FactsBlock(view.knowledge, history, now, openFacet)
						DetailItem.Knowledge -> KnowledgeBlock(view.knowledge, requests, target) { answer, question ->
							scope.launch { ops.askKnowledge(target, answer, question) }
						}
						DetailItem.Documentation -> DocumentationBlock(view.knowledge)
						DetailItem.SourceTitle -> SourceTitle(view.source)
						is DetailItem.SourceLine -> Box(
							Modifier.fillMaxWidth().padding(horizontal = 12.dp).background(Color(CodePalette.BACKGROUND)),
						) {
							PaintedCodeRow(row.line, numbered = true)
						}
						is DetailItem.ShowAll -> TextButton(
							onClick = hapticClick { whole = true },
							modifier = Modifier.padding(start = 12.dp),
						) {
							Text("Show all ${row.lines} lines")
						}
					}
				}
			}
		}
		Button(
			onClick = hapticClick(onOpenWindow),
			modifier = Modifier.fillMaxWidth().padding(12.dp),
			enabled = view.source is WorkspaceAnswer.Read,
		) {
			Text("Open Window")
		}
	}
}

@Composable
private fun SymbolHeader(identity: SymbolIdentity?, fallback: String) {
	Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			KindBadge(identity?.kind)
			identity?.container?.let {
				Text(
					"$it.",
					style = MaterialTheme.typography.titleMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
			}
			Text(
				identity?.name ?: fallback,
				style = MaterialTheme.typography.titleMedium,
				fontWeight = FontWeight.SemiBold,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
		}
		identity?.module?.let {
			Text(
				whereText(it, identity.startLine, identity.endLine),
				style = MaterialTheme.typography.labelSmall,
				fontFamily = FontFamily.Monospace,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

@Composable
private fun ReachedCard(reached: Reached, onJump: () -> Unit) {
	Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
		FacetSection("Reached from")
		OutlinedCard(
			Modifier.fillMaxWidth(),
			colors = CardDefaults.outlinedCardColors(containerColor = Color(CodePalette.MARK_BAND)),
			border = BorderStroke(1.dp, Color(CodePalette.MARK)),
		) {
			Row(
				Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 9.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text(
					reached.name,
					style = MaterialTheme.typography.labelLarge,
					fontFamily = FontFamily.Monospace,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
				RoleChip(reached.role, RoleTone.PLAIN)
				Text(
					"at line ${reached.line}",
					Modifier.weight(1f),
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				TextButton(onClick = hapticClick(onJump)) {
					Text("Line")
					Icon(Icons.Default.ArrowDownward, contentDescription = null, Modifier.size(16.dp))
				}
			}
		}
	}
}

@Composable
private fun FactsBlock(
	knowledge: WorkspaceAnswer<WorkspaceKnowledgeAnswer>?,
	history: FacetState<WorkspaceFacetAnswer>,
	now: () -> Long,
	onOpen: (FacetEntry) -> Unit,
) {
	Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		FacetSection("Facts")
		WorkspaceAnswerBox(knowledge) { answer ->
			when (val rows = remember(answer, history) { factRows(answer, history, now()) }) {
				null -> WorkspaceNotice("Update this session's plugin to see what Lexicon counts")
				is FactRows.Counted -> FactsCard(rows.rows, onOpen)
				is FactRows.Legacy -> Column(Modifier.fillMaxWidth()) {
					FactsCard(rows.rows, onOpen)
					WorkspaceNotice("Update this session's plugin to open these")
				}
			}
		}
	}
}

@Composable
private fun FactsCard(rows: List<FactRow>, onOpen: (FacetEntry) -> Unit) {
	OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
		rows.forEachIndexed { index, row ->
			FactRowLine(row, onOpen)
			if (index < rows.lastIndex) HorizontalDivider()
		}
	}
}

@Composable
private fun FactRowLine(row: FactRow, onOpen: (FacetEntry) -> Unit) {
	val colors = MaterialTheme.colorScheme
	Row(
		Modifier.fillMaxWidth()
			.let { if (!row.opens) it else it.clickable(onClick = hapticClick { onOpen(row.entry) }) }
			.padding(horizontal = 11.dp, vertical = 11.dp),
		horizontalArrangement = Arrangement.spacedBy(10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text(
			row.label,
			Modifier.weight(1f),
			style = MaterialTheme.typography.bodyMedium,
			color = if (row.opens) colors.onSurface else colors.outline,
		)
		Text(
			row.value,
			style = MaterialTheme.typography.labelMedium,
			color = if (row.opens) colors.onSurfaceVariant else colors.outline,
		)
		// Held open, or a dim row shifts the value beside it.
		Box(Modifier.size(18.dp)) { if (row.opens) Chevron() }
	}
}

@Composable
private fun KnowledgeBlock(
	knowledge: WorkspaceAnswer<WorkspaceKnowledgeAnswer>?,
	requests: Map<RequestKey, RequestState>,
	target: WorkspaceTarget,
	onAsk: (WorkspaceKnowledgeAnswer, String) -> Unit,
) {
	Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		FacetSection("Knowledge")
		WorkspaceAnswerBox(knowledge) { answer ->
			val rows = knowledgeRows(answer)
			Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
				if (rows == null) {
					WorkspaceNotice("Update this session's plugin to see what Lexicon knows")
				} else {
					for (row in rows) {
						KnowledgeCard(
							row = row,
							state = requests[knowledgeRequest(target, answer.symbolId, row.question)],
							onAsk = { onAsk(answer, row.question) },
						)
					}
				}
			}
		}
	}
}

@Composable
private fun DocumentationBlock(knowledge: WorkspaceAnswer<WorkspaceKnowledgeAnswer>?) {
	val doc = (knowledge as? WorkspaceAnswer.Read)?.value?.documentation ?: return
	Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		FacetSection("Documentation")
		OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
			Text(doc, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
		}
	}
}

/** Always titled, since the read's own refusal is drawn under it. */
@Composable
private fun SourceTitle(source: WorkspaceAnswer<*>?) {
	Column(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		FacetSection("Source")
		when (source) {
			null -> Box(Modifier.fillMaxWidth().padding(24.dp), Alignment.Center) { CircularProgressIndicator() }
			is WorkspaceAnswer.Refused -> WorkspaceNotice(source.reason)
			WorkspaceAnswer.Unreachable -> WorkspaceNotice("This session could not be reached")
			is WorkspaceAnswer.Read -> Unit
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

