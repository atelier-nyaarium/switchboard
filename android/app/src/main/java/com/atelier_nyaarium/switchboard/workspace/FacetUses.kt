package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.CodePalette
import com.atelier_nyaarium.switchboard.DetailOpen
import com.atelier_nyaarium.switchboard.FacetEntry
import com.atelier_nyaarium.switchboard.RoleTone
import com.atelier_nyaarium.switchboard.UseGrouping
import com.atelier_nyaarium.switchboard.UseItem
import com.atelier_nyaarium.switchboard.countText
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.initialGrouping
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.roleChips
import com.atelier_nyaarium.switchboard.targetItems
import com.atelier_nyaarium.switchboard.useItems
import com.atelier_nyaarium.switchboard.useLinePaint

/** Every use, lazily: only rows on screen paint their line. */
@Composable
internal fun UsesList(answer: WorkspaceFacetAnswer.Uses, entry: FacetEntry, onOpen: (DetailOpen) -> Unit) {
	var grouping by rememberSaveable(entry) { mutableStateOf(initialGrouping(entry)) }
	var role by rememberSaveable(entry) { mutableStateOf<String?>(null) }
	val chips = remember(answer) { roleChips(answer.rows) }
	val items = remember(answer, grouping, role) { useItems(answer.rows, grouping, role) }

	Column(Modifier.fillMaxSize()) {
		SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
			UseGrouping.entries.forEachIndexed { index, option ->
				SegmentedButton(
					selected = grouping == option,
					onClick = hapticClick { grouping = option },
					shape = SegmentedButtonDefaults.itemShape(index, UseGrouping.entries.size),
				) {
					Text(if (option == UseGrouping.BY_SYMBOL) "By symbol" else "By file", maxLines = 1)
				}
			}
		}
		if (chips.isNotEmpty()) {
			Row(
				Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
				horizontalArrangement = Arrangement.spacedBy(6.dp),
			) {
				for (chip in chips) {
					FilterChip(
						selected = role == chip.role,
						onClick = hapticClick { role = chip.role },
						label = { Text("${chip.label} ${countText(chip.count)}", maxLines = 1, softWrap = false) },
					)
				}
			}
		}
		UseItems(items, onOpen)
	}
}

/** The same rows pointed the other way, with no grouping to choose. */
@Composable
internal fun TargetsList(answer: WorkspaceFacetAnswer.UsesFrom, onOpen: (DetailOpen) -> Unit) {
	val items = remember(answer) { targetItems(answer.targets) }
	UseItems(items, onOpen)
}

@Composable
private fun UseItems(items: List<UseItem>, onOpen: (DetailOpen) -> Unit) {
	LazyColumn(Modifier.fillMaxSize()) {
		for (row in items) {
			when (row) {
				is UseItem.Header -> stickyHeader(key = row.key) { GroupHeader(row, onOpen) }
				is UseItem.Row -> item(key = row.key) { UseCard(row, onOpen) }
			}
		}
	}
}

@Composable
private fun GroupHeader(header: UseItem.Header, onOpen: (DetailOpen) -> Unit) {
	val colors = MaterialTheme.colorScheme
	val opens = header.opens
	val outlined = header.outside != null
	Row(
		Modifier.fillMaxWidth()
			.background(colors.surface)
			.let { if (opens == null) it else it.clickable(onClick = hapticClick { onOpen(opens) }) }
			.padding(horizontal = 12.dp, vertical = 6.dp)
			.let { if (outlined) it.dashedOutline(colors.outline).padding(horizontal = 10.dp, vertical = 8.dp) else it },
		horizontalArrangement = Arrangement.spacedBy(9.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		if (header.declaration) KindBadge(header.kind)
		Column(Modifier.weight(1f)) {
			Text(
				header.title,
				style = MaterialTheme.typography.bodyMedium,
				fontFamily = if (header.declaration) FontFamily.Default else FontFamily.Monospace,
				fontWeight = if (header.declaration) FontWeight.SemiBold else FontWeight.Normal,
				color = if (outlined) colors.onSurfaceVariant else colors.onSurface,
				maxLines = 1,
				overflow = if (header.declaration) TextOverflow.Ellipsis else TextOverflow.StartEllipsis,
			)
			header.where?.let { WhereLine(it) }
			header.outside?.let {
				Text(it, style = MaterialTheme.typography.labelSmall, color = colors.outline, maxLines = 1)
			}
		}
		Text(countText(header.count), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
		if (opens != null) Chevron()
	}
}

@Composable
private fun UseCard(row: UseItem.Row, onOpen: (DetailOpen) -> Unit) {
	val line = remember(row.key) { useLinePaint(row.use) }
	val opens = row.opens
	Column(
		Modifier.fillMaxWidth()
			.padding(start = 14.dp, end = 12.dp, bottom = 6.dp)
			.background(Color(CodePalette.USE_CARD), RoundedCornerShape(8.dp))
			.let { if (opens == null) it else it.clickable(onClick = hapticClick { onOpen(opens) }) }
			.padding(horizontal = 10.dp, vertical = 7.dp),
	) {
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
			Text(
				row.label,
				style = MaterialTheme.typography.labelMedium,
				fontFamily = FontFamily.Monospace,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
			RoleChip(row.role, row.tone)
			Text(
				"${row.line}",
				Modifier.weight(1f),
				style = MaterialTheme.typography.labelSmall,
				fontFamily = FontFamily.Monospace,
				color = MaterialTheme.colorScheme.outline,
				textAlign = TextAlign.End,
			)
		}
		UseCode(line, Modifier.padding(top = 5.dp))
	}
}

@Composable
internal fun RoleChip(label: String, tone: RoleTone) {
	val colors = MaterialTheme.colorScheme
	val (container, content) = when (tone) {
		RoleTone.HERITAGE -> colors.secondaryContainer to colors.onSecondaryContainer
		RoleTone.PLAIN -> colors.surfaceVariant to colors.onSurfaceVariant
	}
	Text(
		label.uppercase(),
		Modifier.background(container, RoundedCornerShape(10.dp)).padding(horizontal = 7.dp, vertical = 1.dp),
		style = MaterialTheme.typography.labelSmall,
		fontWeight = FontWeight.Bold,
		color = content,
		maxLines = 1,
	)
}

@Composable
internal fun Chevron() {
	Icon(
		Icons.Default.ChevronRight,
		contentDescription = null,
		Modifier.size(18.dp),
		tint = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}
