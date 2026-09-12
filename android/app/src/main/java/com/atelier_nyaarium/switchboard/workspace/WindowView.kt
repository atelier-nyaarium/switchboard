package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.Window
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.gapBetween
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.inFileOrder
import com.atelier_nyaarium.switchboard.modulesOf
import com.atelier_nyaarium.switchboard.neighbourBounds
import com.atelier_nyaarium.switchboard.opensModule
import com.atelier_nyaarium.switchboard.windowLines
import kotlinx.coroutines.launch

/**
 * The open windows down one scroll, each with the file either side of it read-only. The file is read
 * once per module for that context; a module that cannot be read draws its spans alone.
 */
@Composable
internal fun WindowView(
	ops: WindowOps,
	target: WorkspaceTarget,
	windows: List<Window>,
	onClose: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	val ordered = inFileOrder(windows)
	val modules = modulesOf(ordered)
	var context by remember(target.key) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
	val scope = rememberCoroutineScope()

	LaunchedEffect(target.key, modules) {
		for (module in modules) {
			ops.contextFor(target, module)?.let { context = context + (module to it) }
		}
	}

	if (ordered.isEmpty()) {
		WorkspaceNotice("Long press a symbol in an outline to open a window", modifier)
		return
	}

	LazyColumn(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		for ((index, window) in ordered.withIndex()) {
			val (previousEnd, nextStart) = neighbourBounds(ordered, index)
			if (opensModule(ordered, index)) {
				item(key = "module:${window.descriptor.module}") {
					Text(
						window.descriptor.module,
						Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
						style = MaterialTheme.typography.labelSmall,
						fontFamily = FontFamily.Monospace,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			} else {
				gapBetween(ordered[index - 1], window)?.let { skipped ->
					item(key = "gap:${window.descriptor.symbolId}") { GapRow(skipped) }
				}
			}
			item(key = "window:${window.descriptor.symbolId}") {
				WindowCard(
					window = window,
					file = context[window.descriptor.module],
					previousEnd = previousEnd,
					nextStart = nextStart,
					onRefresh = { scope.launch { ops.adopt(target, window.descriptor.symbolId) } },
					onClose = { onClose(window.descriptor.symbolId) },
				)
			}
		}
	}
}

@Composable
private fun GapRow(skipped: Int) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 16.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		HorizontalDivider(Modifier.weight(1f))
		Text(
			if (skipped == 1) "1 line" else "$skipped lines",
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		HorizontalDivider(Modifier.weight(1f))
	}
}

@Composable
private fun WindowCard(
	window: Window,
	file: List<String>?,
	previousEnd: Int?,
	nextStart: Int?,
	onRefresh: () -> Unit,
	onClose: () -> Unit,
) {
	Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
		Column(Modifier.fillMaxWidth()) {
			Row(
				Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, end = 4.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text(
					window.descriptor.name,
					Modifier.weight(1f),
					style = MaterialTheme.typography.titleSmall,
					fontFamily = FontFamily.Monospace,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
				if (window.edited) {
					Text(
						"EDITED",
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.primary,
					)
				}
				Text(
					"${window.descriptor.startLine}-${window.descriptor.endLine}",
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				TextButton(onClick = hapticClick(onClose)) { Text("Close") }
			}
			if (window.stale) {
				OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
					Row(
						Modifier.fillMaxWidth().padding(start = 12.dp),
						horizontalArrangement = Arrangement.spacedBy(8.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
							Text("Stale Window", style = MaterialTheme.typography.labelLarge)
							Text("The code here changed.", style = MaterialTheme.typography.bodySmall)
						}
						TextButton(onClick = hapticClick(onRefresh)) { Text("Refresh") }
					}
				}
			}
			CodeLines(
				windowLines(window, file, previousEnd = previousEnd, nextStart = nextStart),
				Modifier.padding(vertical = 6.dp),
			)
		}
	}
}
