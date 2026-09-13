package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ArmedAction
import com.atelier_nyaarium.switchboard.ArmedFileOp
import com.atelier_nyaarium.switchboard.Arming
import com.atelier_nyaarium.switchboard.CreateFile
import com.atelier_nyaarium.switchboard.FileAction
import com.atelier_nyaarium.switchboard.FileOpResult
import com.atelier_nyaarium.switchboard.PathAsk
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceFileOps
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.childPath
import com.atelier_nyaarium.switchboard.confirmOf
import com.atelier_nyaarium.switchboard.fileOpNotice
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.opensDirectory
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry
import com.atelier_nyaarium.switchboard.rawToOpen
import com.atelier_nyaarium.switchboard.treeMoved
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkspaceTree(
	ops: WindowOps,
	fileOps: WorkspaceFileOps,
	target: WorkspaceTarget,
	path: String,
	onOpenDirectory: (String) -> Unit,
	onOpenOutline: (String) -> Unit,
	onOpenRaw: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	var answer by remember(target.key, path) { mutableStateOf<WorkspaceAnswer<WorkspaceTreeAnswer>?>(null) }
	var sheetFor by remember(target.key, path) { mutableStateOf<String?>(null) }
	var reloads by remember(target.key, path) { mutableIntStateOf(0) }
	var asking by remember(target.key, path) { mutableStateOf<PathAsk?>(null) }
	var confirming by remember(target.key, path) { mutableStateOf<ArmedFileOp?>(null) }
	var busy by remember(target.key, path) { mutableStateOf(false) }
	var notice by remember(target.key, path) { mutableStateOf<String?>(null) }
	val scope = rememberCoroutineScope()
	LaunchedEffect(target.key, path, reloads) { answer = ops.tree(target, path) }

	fun run(action: FileAction, work: suspend () -> FileOpResult) {
		busy = true
		notice = null
		scope.launch {
			val result = work()
			busy = false
			notice = fileOpNotice(action, result)
			if (treeMoved(result)) reloads++
			rawToOpen(action, result)?.let(onOpenRaw)
		}
	}

	fun chosen(action: FileAction) {
		asking = null
		when (action) {
			is CreateFile -> run(action) { fileOps.create(target, action.path) }
			is ArmedAction -> {
				busy = true
				notice = null
				scope.launch {
					when (val arming = fileOps.arm(target, action)) {
						is Arming.Armed -> confirming = arming.op
						is Arming.Refused -> notice = arming.reason
					}
					busy = false
				}
			}
		}
	}

	WorkspaceAnswerBox(answer, modifier) { tree ->
		Column(Modifier.fillMaxSize()) {
			Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
				if (busy) LinearProgressIndicator(Modifier.weight(1f).padding(horizontal = 8.dp)) else Spacer(Modifier.weight(1f))
				TextButton(onClick = hapticClick { asking = PathAsk(PathAsk.Kind.Create, path) }, enabled = !busy) {
					Text("New file")
				}
			}
			notice?.let { WorkspaceNotice(it) }
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
				if (!busy) {
					SheetAction("Copy to") {
						sheetFor = null
						asking = PathAsk(PathAsk.Kind.Copy, childPath(path, name))
					}
					SheetAction("Move to") {
						sheetFor = null
						asking = PathAsk(PathAsk.Kind.Move, childPath(path, name))
					}
					SheetAction("Delete") {
						sheetFor = null
						chosen(ArmedAction.Delete(childPath(path, name)))
					}
				}
			}
		}
	}

	// Each tap reads the state as it stands, so a second tap before the dialog leaves does nothing.
	asking?.let { ask -> PathDialog(ask, onChosen = { if (asking != null) chosen(it) }, onDismiss = { asking = null }) }

	confirming?.let { shown ->
		ConfirmFileOpDialog(
			confirm = confirmOf(shown),
			onConfirm = {
				confirming?.let { op ->
					confirming = null
					run(op.action) { fileOps.perform(target, op) }
				}
			},
			onDismiss = { confirming = null },
		)
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
