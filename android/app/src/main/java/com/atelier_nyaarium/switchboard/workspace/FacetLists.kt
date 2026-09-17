package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.CommentItem
import com.atelier_nyaarium.switchboard.DetailOpen
import com.atelier_nyaarium.switchboard.FileStrip
import com.atelier_nyaarium.switchboard.HierarchyColumn
import com.atelier_nyaarium.switchboard.HistoryBody
import com.atelier_nyaarium.switchboard.RoleTone
import com.atelier_nyaarium.switchboard.TextPart
import com.atelier_nyaarium.switchboard.TypeNode
import com.atelier_nyaarium.switchboard.commentItems
import com.atelier_nyaarium.switchboard.diffTint
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.memberChips
import com.atelier_nyaarium.switchboard.membersOfKind
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.signaturePaint
import com.atelier_nyaarium.switchboard.whereText

/** Declared members in source order, each with the signature its row does not repeat. */
@Composable
internal fun MembersList(answer: WorkspaceFacetAnswer.Members, onOpen: (DetailOpen) -> Unit) {
	var kind by rememberSaveable { mutableStateOf<String?>(null) }
	val chips = remember(answer) { memberChips(answer.members) }
	val shown = remember(answer, kind) { membersOfKind(answer.members, kind) }

	Column(Modifier.fillMaxSize()) {
		if (chips.isNotEmpty()) {
			Row(
				Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
				horizontalArrangement = Arrangement.spacedBy(6.dp),
			) {
				for (chip in chips) {
					FilterChip(
						selected = kind == chip.kind,
						onClick = hapticClick { kind = chip.kind },
						label = { Text("${chip.label} ${chip.count}", maxLines = 1, softWrap = false) },
					)
				}
			}
		}
		LazyColumn(Modifier.fillMaxSize()) {
			for (member in shown) {
				item(key = "m:${member.symbolId}") {
					MemberRow(member, onOpen)
					HorizontalDivider()
				}
			}
		}
	}
}

@Composable
private fun MemberRow(member: WorkspaceFacetSymbol, onOpen: (DetailOpen) -> Unit) {
	val signature = remember(member) { signaturePaint(member) }
	Row(
		Modifier.fillMaxWidth()
			.clickable(onClick = hapticClick { onOpen(DetailOpen(member.symbolId, member.module, member.name)) })
			.padding(start = 12.dp, end = 6.dp, top = 9.dp, bottom = 10.dp),
		horizontalArrangement = Arrangement.spacedBy(10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		KindBadge(member.symbolKind)
		Column(Modifier.weight(1f)) {
			Text(
				member.name,
				style = MaterialTheme.typography.bodyMedium,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
			signature?.let { UseCode(it, Modifier.padding(top = 2.dp)) }
		}
		member.startLine?.let {
			Text(
				"$it",
				style = MaterialTheme.typography.labelSmall,
				fontFamily = FontFamily.Monospace,
				color = MaterialTheme.colorScheme.outline,
			)
		}
		Chevron()
	}
}

/** One chain: farthest ancestor at the top, the symbol in the middle, what descends below. */
@Composable
internal fun HierarchyBody(column: HierarchyColumn, onOpen: (DetailOpen) -> Unit) {
	val rail = MaterialTheme.colorScheme.outlineVariant
	Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
		FacetSection("Supertypes")
		if (column.above.isEmpty()) {
			NoneLine()
		} else {
			for (node in column.above) {
				TypeNodeCard(node, onOpen, Modifier.padding(horizontal = 12.dp))
				Box(Modifier.padding(start = 32.dp).width(2.dp).height(14.dp).background(rail))
			}
		}
		TypeNodeCard(column.self, onOpen, Modifier.padding(horizontal = 12.dp))
		FacetSection("Subtypes")
		if (column.below.isEmpty()) {
			NoneLine()
		} else {
			Row(Modifier.padding(start = 32.dp, end = 12.dp).height(IntrinsicSize.Min)) {
				Box(Modifier.width(2.dp).fillMaxHeight().background(rail))
				Column(
					Modifier.padding(start = 12.dp, top = 7.dp),
					verticalArrangement = Arrangement.spacedBy(7.dp),
				) {
					for (node in column.below) TypeNodeCard(node, onOpen, Modifier)
				}
			}
		}
	}
}

@Composable
private fun NoneLine() {
	Text(
		"None.",
		Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
		style = MaterialTheme.typography.bodySmall,
		color = MaterialTheme.colorScheme.outline,
	)
}

@Composable
private fun TypeNodeCard(node: TypeNode, onOpen: (DetailOpen) -> Unit, modifier: Modifier) {
	val colors = MaterialTheme.colorScheme
	when (node) {
		is TypeNode.Unbound -> Row(
			modifier.fillMaxWidth().dashedOutline(colors.outline).padding(horizontal = 11.dp, vertical = 9.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Column(Modifier.weight(1f)) {
				Text(node.name, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
				Text("not indexed", style = MaterialTheme.typography.labelSmall, color = colors.outline)
			}
			node.tag?.let { TagText(it) }
		}
		is TypeNode.Known -> OutlinedCard(
			modifier.fillMaxWidth().let {
				if (!node.opens) {
					it
				} else {
					it.clickable(
						onClick = hapticClick { onOpen(DetailOpen(node.symbolId, node.module, node.name)) },
					)
				}
			},
			colors = if (node.self) {
				CardDefaults.outlinedCardColors(containerColor = colors.secondaryContainer)
			} else {
				CardDefaults.outlinedCardColors()
			},
		) {
			Row(
				Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 9.dp),
				horizontalArrangement = Arrangement.spacedBy(10.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				KindBadge(node.kind)
				Column(Modifier.weight(1f)) {
					Text(
						node.name,
						style = MaterialTheme.typography.bodyMedium,
						fontWeight = if (node.self) FontWeight.Bold else FontWeight.Normal,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
					WhereLine(whereText(node.module, node.startLine))
				}
				node.tag?.let { TagText(it) }
				if (node.opens) Chevron()
			}
		}
	}
}

@Composable
private fun TagText(tag: String) {
	Text(tag, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Each comment under the member it sits on, its backticked spans in mono. */
@Composable
internal fun CommentsList(answer: WorkspaceFacetAnswer.Comments, onOpen: (DetailOpen) -> Unit) {
	val items = remember(answer) { commentItems(answer) }
	LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
		for (comment in items) {
			item(key = comment.key) { CommentCard(comment, onOpen) }
		}
	}
}

@Composable
private fun CommentCard(comment: CommentItem, onOpen: (DetailOpen) -> Unit) {
	val colors = MaterialTheme.colorScheme
	val opens = comment.opens
	val text = remember(comment) { commentText(comment.parts) }
	OutlinedCard(
		Modifier.fillMaxWidth()
			.padding(bottom = 8.dp)
			.let { if (opens == null) it else it.clickable(onClick = hapticClick { onOpen(opens) }) },
	) {
		Column(Modifier.padding(horizontal = 11.dp, vertical = 9.dp)) {
			Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
				RoleChip(comment.form, RoleTone.PLAIN)
				comment.holder?.let {
					Text(
						"on $it",
						style = MaterialTheme.typography.labelSmall,
						color = colors.onSurfaceVariant,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
				}
				Text(
					"${comment.line}",
					Modifier.weight(1f),
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = colors.outline,
					textAlign = TextAlign.End,
				)
				if (opens != null) Chevron()
			}
			Row(Modifier.padding(top = 6.dp).height(IntrinsicSize.Min)) {
				// The rail marks prose, so it stays quiet: the error tone reads as a warning.
				Box(Modifier.width(2.dp).fillMaxHeight().background(colors.outlineVariant))
				Text(
					text,
					Modifier.padding(start = 9.dp),
					style = MaterialTheme.typography.bodySmall,
					color = colors.onSurfaceVariant,
				)
			}
		}
	}
}

private fun commentText(parts: List<TextPart>): AnnotatedString =
	buildAnnotatedString {
		for (part in parts) {
			if (part.code) {
				pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
				append(part.text)
				pop()
			} else {
				append(part.text)
			}
		}
	}

/** The commits that touched a symbol's own lines, then the file's own history. */
@Composable
internal fun HistoryBodyView(body: HistoryBody, strip: FileStrip?) {
	Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
		when (body) {
			is HistoryBody.Empty -> WorkspaceNotice(body.text)
			is HistoryBody.Commits -> {
				FacetSection("Commits that touched these lines")
				OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
					body.items.forEachIndexed { index, commit ->
						Row(
							Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 9.dp),
							horizontalArrangement = Arrangement.spacedBy(10.dp),
						) {
							Text(
								commit.shortHash,
								style = MaterialTheme.typography.labelSmall,
								fontFamily = FontFamily.Monospace,
								color = MaterialTheme.colorScheme.primary,
							)
							Column(Modifier.weight(1f)) {
								Text(
									commit.subject,
									style = MaterialTheme.typography.bodySmall,
									maxLines = 2,
									overflow = TextOverflow.Ellipsis,
								)
								Text(
									commit.age,
									style = MaterialTheme.typography.labelSmall,
									color = MaterialTheme.colorScheme.outline,
								)
							}
						}
						if (index < body.items.lastIndex) HorizontalDivider()
					}
				}
				body.stoppedAt?.let {
					Text(
						"Stopped at $it",
						Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.outline,
					)
				}
			}
		}
		strip?.let {
			FacetSection("From the file outline")
			FileHistoryStrip(it, Modifier.padding(horizontal = 12.dp))
		}
	}
}

/** The file's own history, over its outline. */
@Composable
internal fun FileHistoryStrip(strip: FileStrip, modifier: Modifier = Modifier) {
	when (strip) {
		is FileStrip.Line -> Text(
			strip.text,
			modifier.padding(top = 4.dp),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.outline,
		)
		is FileStrip.Stats -> Row(
			modifier.fillMaxWidth().padding(top = 6.dp),
			horizontalArrangement = Arrangement.spacedBy(7.dp),
		) {
			StatTile(AnnotatedString(strip.stats.sinceLast), "since last change", Modifier.weight(1f))
			StatTile(AnnotatedString(strip.stats.commits), strip.stats.commitsLabel, Modifier.weight(1f))
			StatTile(linesChanged(strip.stats.added, strip.stats.removed), "lines", Modifier.weight(1f))
		}
	}
}

@Composable
private fun linesChanged(added: String, removed: String): AnnotatedString {
	val tint = diffTint(isSystemInDarkTheme())
	return buildAnnotatedString {
		pushStyle(SpanStyle(color = Color(tint.added)))
		append(added)
		pop()
		append(" ")
		pushStyle(SpanStyle(color = Color(tint.removed)))
		append(removed)
		pop()
	}
}

@Composable
private fun StatTile(value: AnnotatedString, label: String, modifier: Modifier) {
	OutlinedCard(modifier) {
		Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
			Text(value, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
			Text(
				label,
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
		}
	}
}
