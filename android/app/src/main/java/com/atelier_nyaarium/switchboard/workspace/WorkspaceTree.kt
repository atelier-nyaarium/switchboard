package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.childPath
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.opensDirectory
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkspaceTree(
	ops: WindowOps,
	target: WorkspaceTarget,
	path: String,
	onOpenDirectory: (String) -> Unit,
	onOpenOutline: (String) -> Unit,
	onOpenRaw: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	var answer by remember(target.key, path) { mutableStateOf<WorkspaceAnswer<WorkspaceTreeAnswer>?>(null) }
	var sheetFor by remember(target.key, path) { mutableStateOf<String?>(null) }
	LaunchedEffect(target.key, path) { answer = ops.tree(target, path) }

	WorkspaceAnswerBox(answer, modifier) { tree ->
		Column(Modifier.fillMaxSize()) {
			if (tree.truncated) {
				WorkspaceNotice("Only the first entries are listed")
			}
			// A blank screen otherwise, which reads as a read that never landed.
			if (tree.entries.isEmpty()) {
				WorkspaceNotice("Nothing here")
			}
			LazyColumn(Modifier.fillMaxSize()) {
				for (entry in tree.entries) {
					item(key = "entry:${entry.name}") {
						TreeRow(
							entry = entry,
							onClick = {
								val child = childPath(path, entry.name)
								if (opensDirectory(entry)) onOpenDirectory(child) else onOpenOutline(child)
							},
							onLongClick = { if (!opensDirectory(entry)) sheetFor = entry.name },
						)
						HorizontalDivider()
					}
				}
			}
		}
	}

	sheetFor?.let { name ->
		ModalBottomSheet(onDismissRequest = { sheetFor = null }) {
			Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
				Text(
					name,
					Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
					style = MaterialTheme.typography.titleMedium,
				)
				SheetAction("Open outline") {
					sheetFor = null
					onOpenOutline(childPath(path, name))
				}
				SheetAction("Edit raw") {
					sheetFor = null
					onOpenRaw(childPath(path, name))
				}
			}
		}
	}
}

@Composable
private fun SheetAction(label: String, onClick: () -> Unit) {
	Text(
		label,
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onClick)).padding(horizontal = 20.dp, vertical = 14.dp),
		style = MaterialTheme.typography.bodyLarge,
	)
}

@Composable
private fun TreeRow(entry: WorkspaceTreeEntry, onClick: () -> Unit, onLongClick: () -> Unit) {
	WorkspaceRow(onClick = onClick, onLongClick = onLongClick) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 11.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text(
				if (entry.directory) "/" else entry.name.substringAfterLast('.', "").take(3).uppercase(),
				Modifier.width(26.dp),
				style = MaterialTheme.typography.labelSmall,
				fontFamily = FontFamily.Monospace,
				textAlign = TextAlign.Center,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			Text(
				entry.name,
				Modifier.weight(1f),
				style = MaterialTheme.typography.bodyMedium,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
			com.atelier_nyaarium.switchboard.treeMeta(entry)?.let {
				Text(
					it,
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
	}
}
