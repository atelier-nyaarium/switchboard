package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.Submitted
import com.atelier_nyaarium.switchboard.SymbolViews
import com.atelier_nyaarium.switchboard.Window
import com.atelier_nyaarium.switchboard.WindowRequests
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.crumbsOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.holdsWindow
import com.atelier_nyaarium.switchboard.linesText
import com.atelier_nyaarium.switchboard.outlineDepths
import com.atelier_nyaarium.switchboard.outlineKinds
import com.atelier_nyaarium.switchboard.outlineOfKind
import com.atelier_nyaarium.switchboard.parentPath
import com.atelier_nyaarium.switchboard.proto.WorkspaceOutlineSymbol
import com.atelier_nyaarium.switchboard.windowsAskNotice
import kotlinx.coroutines.launch

/** A tap reads a symbol, a long press opens a window, so poking around never costs one. */
@Composable
internal fun WorkspaceOutline(
	views: SymbolViews,
	asks: WindowRequests,
	target: WorkspaceTarget,
	path: String,
	held: List<Window>,
	onOpenFolder: (String) -> Unit,
	onOpenDetail: (String) -> Unit,
	onOpenWindow: (String) -> Unit,
	onOpenRaw: () -> Unit,
	onOpenWindows: () -> Unit,
	modifier: Modifier = Modifier,
) {
	val shown by views.outlineViews.collectAsState()
	val requests by asks.requests.collectAsState()
	val answer = shown[target to path]?.outline
	val outline = (answer as? WorkspaceAnswer.Read)?.value
	var kind by remember(target.key, path) { mutableStateOf<String?>(null) }
	var typed by rememberSaveable(target.key, path) { mutableStateOf("") }
	var notice by remember(target.key, path) { mutableStateOf<String?>(null) }
	val scope = rememberCoroutineScope()
	LaunchedEffect(target.key, path) { views.keepOutline(target, path) }

	Column(modifier.fillMaxSize()) {
		Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp)) {
			Breadcrumbs(crumbsOf(outline?.root, parentPath(path)), prefix = "", onOpenFolder = onOpenFolder)
			Row(verticalAlignment = Alignment.CenterVertically) {
				Text(
					path.substringAfterLast('/'),
					Modifier.weight(1f),
					style = MaterialTheme.typography.titleMedium,
					fontWeight = FontWeight.SemiBold,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
				outline?.lines?.let {
					Text(
						linesText(it),
						style = MaterialTheme.typography.labelSmall,
						fontFamily = FontFamily.Monospace,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
			Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
				OutlinedTextField(
					value = typed,
					onValueChange = { typed = it },
					modifier = Modifier.weight(1f),
					placeholder = { Text("Ask for the windows you want") },
					textStyle = MaterialTheme.typography.bodyMedium,
					maxLines = 3,
				)
				IconButton(
					onClick = hapticClick {
						val text = typed
						scope.launch {
							val submitted = asks.ask(target, path, text)
							notice = windowsAskNotice(submitted)
							if (submitted == Submitted.Sent && typed == text) typed = ""
						}
					},
					enabled = typed.isNotBlank(),
				) {
					Icon(Icons.Default.ArrowUpward, contentDescription = "Ask")
				}
			}
			requests[target.address]?.takeIf { it.opened == null }?.let { waiting ->
				PendingAsk(waiting.text, waiting.module, onDismiss = { asks.dismiss(target) })
			}
			notice?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
		}
		HorizontalDivider()
		WorkspaceAnswerBox(answer, Modifier.weight(1f)) { read ->
			val shownSymbols = outlineOfKind(read.symbols, kind)
			val depths = remember(read.symbols) { outlineDepths(read.symbols) }
			Column(Modifier.fillMaxSize()) {
				Row(
					Modifier.fillMaxWidth().padding(horizontal = 12.dp),
					horizontalArrangement = Arrangement.spacedBy(6.dp),
				) {
					for (counted in outlineKinds(read.symbols)) {
						FilterChip(
							selected = kind == counted.kind,
							onClick = { kind = counted.kind },
							label = { Text("${counted.label} ${counted.count}") },
						)
					}
				}
				LazyColumn(Modifier.fillMaxSize()) {
					for (symbol in shownSymbols) {
						item(key = "symbol:${symbol.symbolId}") {
							OutlineRow(
								symbol = symbol,
								depth = depths[symbol.symbolId] ?: 0,
								windowed = holdsWindow(held, symbol.symbolId),
								onClick = { onOpenDetail(symbol.symbolId) },
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
private fun PendingAsk(text: String, module: String, onDismiss: () -> Unit) {
	Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
		Column(Modifier.weight(1f)) {
			Text("Waiting for a reply", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
			Text(
				"${module.substringAfterLast('/')}: $text",
				style = MaterialTheme.typography.bodySmall,
				maxLines = 2,
				overflow = TextOverflow.Ellipsis,
			)
		}
		IconButton(onClick = hapticClick(onDismiss)) { Icon(Icons.Default.Close, contentDescription = "Dismiss") }
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
				.padding(start = 12.dp + (depth * 18).dp, top = 10.dp, end = 6.dp, bottom = 10.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			KindBadge(symbol.symbolKind)
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
			Icon(
				Icons.Default.ChevronRight,
				contentDescription = null,
				Modifier.size(18.dp),
				tint = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}
