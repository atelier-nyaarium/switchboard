package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ArmedAction
import com.atelier_nyaarium.switchboard.PathAsk
import com.atelier_nyaarium.switchboard.SessionRequests
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceFileOps
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.sendable
import com.atelier_nyaarium.switchboard.childPath
import com.atelier_nyaarium.switchboard.confirmOf
import com.atelier_nyaarium.switchboard.crumbsOf
import com.atelier_nyaarium.switchboard.fileRequest
import com.atelier_nyaarium.switchboard.fileSummary
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.opensDirectory
import com.atelier_nyaarium.switchboard.outcomeText
import com.atelier_nyaarium.switchboard.parentPath
import com.atelier_nyaarium.switchboard.projectName
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry
import com.atelier_nyaarium.switchboard.rootPrefix
import com.atelier_nyaarium.switchboard.sendFile
import com.atelier_nyaarium.switchboard.sendLabel
import com.atelier_nyaarium.switchboard.treeMeta
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkspaceTree(
	fileOps: WorkspaceFileOps,
	requests: SessionRequests,
	target: WorkspaceTarget,
	session: String,
	path: String,
	openWindows: Int,
	onOpenDirectory: (String) -> Unit,
	onOpenFolder: (String) -> Unit,
	onOpenOutline: (String) -> Unit,
	onOpenRaw: (String) -> Unit,
	onOpenWindows: () -> Unit,
	modifier: Modifier = Modifier,
) {
	val views by fileOps.views.collectAsState()
	val sent by requests.states.collectAsState()
	val view = views[target to path]
	val listing = (view?.listing as? WorkspaceAnswer.Read)?.value
	var sheetFor by remember(target.key, path) { mutableStateOf<WorkspaceTreeEntry?>(null) }
	val scope = rememberCoroutineScope()
	LaunchedEffect(target.key, path) { fileOps.keepOpen(target, path) }
	LaunchedEffect(view?.openRaw) {
		view?.openRaw?.let {
			fileOps.rawOpened(target, path)
			onOpenRaw(it)
		}
	}

	Column(modifier.fillMaxSize()) {
		Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 6.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Text(
					projectName(listing?.root),
					Modifier.weight(1f),
					style = MaterialTheme.typography.titleMedium,
					fontWeight = FontWeight.SemiBold,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
				if (openWindows > 0) {
					TextButton(onClick = hapticClick(onOpenWindows)) { Text("$openWindows open") }
				}
				Text(
					session,
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				IconButton(
					onClick = hapticClick { fileOps.ask(target, path, PathAsk(PathAsk.Kind.Create, path)) },
					enabled = view?.busy != true,
				) {
					Icon(Icons.Default.Add, contentDescription = "New file")
				}
			}
			Breadcrumbs(crumbsOf(listing?.root, path), rootPrefix(listing?.root), onOpenFolder)
		}
		if (view?.busy == true) {
			LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp))
		}
		HorizontalDivider(Modifier.padding(top = 6.dp))
		WorkspaceAnswerBox(view?.listing, Modifier.weight(1f)) { tree ->
			Column(Modifier.fillMaxSize()) {
				view?.outcome?.let { WorkspaceNotice(outcomeText(it)) }
				if (tree.truncated) {
					WorkspaceNotice("Only the first entries are listed")
				}
				// A blank screen otherwise, which reads as a read that never landed.
				if (tree.entries.isEmpty()) {
					WorkspaceNotice("Nothing here")
				}
				LazyColumn(Modifier.fillMaxSize()) {
					if (path.isNotEmpty()) {
						item(key = "up") {
							UpRow { onOpenFolder(parentPath(path)) }
							HorizontalDivider()
						}
					}
					for (entry in tree.entries) {
						item(key = "entry:${entry.name}") {
							TreeRow(
								entry = entry,
								onClick = {
									val child = childPath(path, entry.name)
									if (opensDirectory(entry)) onOpenDirectory(child) else onOpenOutline(child)
								},
								onLongClick = { if (!opensDirectory(entry)) sheetFor = entry },
							)
							HorizontalDivider()
						}
					}
				}
			}
		}
	}

	sheetFor?.let { entry ->
		val file = childPath(path, entry.name)
		val state = sent[fileRequest(target, file)]
		val act = { action: () -> Unit ->
			sheetFor = null
			action()
		}
		ModalBottomSheet(onDismissRequest = { sheetFor = null }) {
			Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
				Row(
					Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
					horizontalArrangement = Arrangement.spacedBy(12.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					TypeBadge(entry.name)
					Column {
						Text(entry.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
						fileSummary(entry)?.let {
							Text(
								it,
								style = MaterialTheme.typography.labelSmall,
								fontFamily = FontFamily.Monospace,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
					}
				}
				HorizontalDivider()
				SheetAction(Icons.AutoMirrored.Filled.List, "Open outline") { act { onOpenOutline(file) } }
				SheetAction(Icons.Default.Edit, "Edit raw") { act { onOpenRaw(file) } }
				if (view?.busy != true) {
					HorizontalDivider()
					SheetAction(Icons.AutoMirrored.Filled.DriveFileMove, "Move") {
						act { fileOps.ask(target, path, PathAsk(PathAsk.Kind.Move, file)) }
					}
					SheetAction(Icons.Default.ContentCopy, "Duplicate") {
						act { fileOps.ask(target, path, PathAsk(PathAsk.Kind.Duplicate, file)) }
					}
					SheetAction(Icons.Default.DriveFileRenameOutline, "Rename") {
						act { fileOps.ask(target, path, PathAsk(PathAsk.Kind.Rename, file)) }
					}
				}
				SheetAction(Icons.AutoMirrored.Filled.Send, sendLabel(state), enabled = sendable(state)) {
					scope.launch { requests.sendFile(target, file) }
				}
				if (view?.busy != true) {
					HorizontalDivider()
					SheetAction(Icons.Default.Delete, "Delete", tint = MaterialTheme.colorScheme.error) {
						act { scope.launch { fileOps.begin(target, path, ArmedAction.Delete(file)) } }
					}
				}
			}
		}
	}

	view?.asking?.let { ask ->
		PathDialog(
			ask,
			onChosen = { action -> scope.launch { fileOps.choose(target, path, action) } },
			onDismiss = { fileOps.dismiss(target, path) },
		)
	}

	view?.confirming?.let { op ->
		ConfirmFileOpDialog(
			confirm = confirmOf(op),
			onConfirm = { scope.launch { fileOps.confirm(target, path) } },
			onDismiss = { fileOps.dismiss(target, path) },
		)
	}
}

@Composable
private fun SheetAction(
	icon: ImageVector,
	label: String,
	enabled: Boolean = true,
	tint: Color = Color.Unspecified,
	onClick: () -> Unit,
) {
	val color = when {
		!enabled -> MaterialTheme.colorScheme.onSurfaceVariant
		tint != Color.Unspecified -> tint
		else -> MaterialTheme.colorScheme.onSurface
	}
	Row(
		Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = hapticClick(onClick))
			.padding(horizontal = 20.dp, vertical = 13.dp),
		horizontalArrangement = Arrangement.spacedBy(16.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(icon, contentDescription = null, Modifier.size(20.dp), tint = color)
		Text(label, style = MaterialTheme.typography.bodyLarge, color = color)
	}
}

@Composable
private fun UpRow(onClick: () -> Unit) {
	WorkspaceRow(onClick = onClick, onLongClick = null) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 11.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Icon(
				Icons.Default.ArrowUpward,
				contentDescription = "Up",
				Modifier.padding(horizontal = 3.dp).size(20.dp),
				tint = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			Text("..", style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
		}
	}
}

@Composable
private fun TypeBadge(name: String) {
	Text(
		name.substringAfterLast('.', "").take(3).uppercase(),
		Modifier.width(26.dp),
		style = MaterialTheme.typography.labelSmall,
		fontFamily = FontFamily.Monospace,
		textAlign = TextAlign.Center,
		color = MaterialTheme.colorScheme.primary,
	)
}

@Composable
private fun TreeRow(entry: WorkspaceTreeEntry, onClick: () -> Unit, onLongClick: () -> Unit) {
	WorkspaceRow(onClick = onClick, onLongClick = onLongClick) {
		Row(
			Modifier.fillMaxWidth().padding(start = 12.dp, end = 6.dp, top = 11.dp, bottom = 11.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			if (entry.directory) {
				Icon(
					Icons.Default.Folder,
					contentDescription = "Folder",
					Modifier.padding(horizontal = 3.dp).size(20.dp),
					tint = MaterialTheme.colorScheme.tertiary,
				)
			} else {
				TypeBadge(entry.name)
			}
			Text(
				entry.name,
				Modifier.weight(1f),
				style = MaterialTheme.typography.bodyMedium,
				fontWeight = if (entry.directory) FontWeight.SemiBold else FontWeight.Normal,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
			treeMeta(entry)?.let {
				Text(
					it,
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
