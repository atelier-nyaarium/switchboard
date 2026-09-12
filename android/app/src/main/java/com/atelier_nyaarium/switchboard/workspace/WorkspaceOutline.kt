package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.Window
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.holdsWindow
import com.atelier_nyaarium.switchboard.outlineDepths
import com.atelier_nyaarium.switchboard.outlineKinds
import com.atelier_nyaarium.switchboard.outlineOfKind
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol

/** A tap reads a symbol, a long press opens a window, so poking around never costs one. */
@Composable
internal fun WorkspaceOutline(
	ops: WindowOps,
	target: WorkspaceTarget,
	path: String,
	held: List<Window>,
	onOpenDetail: (String, String) -> Unit,
	onOpenWindow: (String) -> Unit,
	onOpenRaw: () -> Unit,
	onOpenWindows: () -> Unit,
	modifier: Modifier = Modifier,
) {
	var answer by remember(target.key, path) { mutableStateOf<WorkspaceAnswer<WorkspaceOutlineAnswer>?>(null) }
	var kind by remember(target.key, path) { mutableStateOf<String?>(null) }
	LaunchedEffect(target.key, path) { answer = ops.outline(target, path) }

	Column(modifier.fillMaxSize()) {
		WorkspaceAnswerBox(answer, Modifier.weight(1f)) { outline ->
			val shown = outlineOfKind(outline.symbols, kind)
			val depths = remember(outline.symbols) { outlineDepths(outline.symbols) }
			Column(Modifier.fillMaxSize()) {
				Row(
					Modifier.fillMaxWidth().padding(horizontal = 12.dp),
					horizontalArrangement = Arrangement.spacedBy(6.dp),
				) {
					for (counted in outlineKinds(outline.symbols)) {
						FilterChip(
							selected = kind == counted.kind,
							onClick = { kind = counted.kind },
							label = { Text("${counted.label} ${counted.count}") },
						)
					}
				}
				LazyColumn(Modifier.fillMaxSize()) {
					for (symbol in shown) {
						item(key = "symbol:${symbol.symbolId}") {
							OutlineRow(
								symbol = symbol,
								depth = depths[symbol.symbolId] ?: 0,
								windowed = holdsWindow(held, symbol.symbolId),
								onClick = { onOpenDetail(symbol.symbolId, symbol.name) },
								onLongClick = { onOpenWindow(symbol.symbolId) },
							)
							HorizontalDivider()
						}
					}
				}
			}
		}
		Row(
			Modifier.fillMaxWidth().padding(12.dp),
			horizontalArrangement = Arrangement.spacedBy(9.dp),
		) {
			OutlinedButton(onClick = hapticClick(onOpenRaw)) { Text("Raw") }
			if (held.isNotEmpty()) {
				Button(onClick = hapticClick(onOpenWindows), modifier = Modifier.weight(1f)) {
					Text(if (held.size == 1) "View 1 window" else "View ${held.size} windows")
				}
			}
		}
	}
}

@Composable
private fun OutlineRow(
	symbol: WorkspaceOutlineSymbol,
	depth: Int,
	windowed: Boolean,
	onClick: () -> Unit,
	onLongClick: () -> Unit,
) {
	WorkspaceRow(onClick = onClick, onLongClick = onLongClick) {
		Row(
			Modifier.fillMaxWidth()
				.padding(start = 12.dp + (depth * 14).dp, top = 10.dp, end = 12.dp, bottom = 10.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text(
				symbol.symbolKind.take(1).uppercase(),
				Modifier.width(22.dp),
				style = MaterialTheme.typography.labelMedium,
				fontFamily = FontFamily.Monospace,
				textAlign = TextAlign.Center,
				color = MaterialTheme.colorScheme.primary,
			)
			Column(Modifier.weight(1f)) {
				Text(
					symbol.name,
					style = MaterialTheme.typography.bodyMedium,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
				symbol.signature?.let {
					Text(
						it,
						style = MaterialTheme.typography.bodySmall,
						fontFamily = FontFamily.Monospace,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
				}
			}
			// The amber mark says a window is open on it, the same colour the code view uses.
			if (windowed) {
				Text(
					"W",
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = Highlight.mark,
				)
			}
			symbol.startLine?.let {
				Text(
					"$it",
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
	}
}
