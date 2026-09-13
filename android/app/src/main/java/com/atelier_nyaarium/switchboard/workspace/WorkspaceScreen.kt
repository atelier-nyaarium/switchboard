package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.Team
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspacePlace
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.holdsWorkspace
import com.atelier_nyaarium.switchboard.placeOf
import com.atelier_nyaarium.switchboard.placeTitle
import com.atelier_nyaarium.switchboard.targetOf
import kotlinx.coroutines.launch

/** Shell owns the stack, so Back and ref exits share it. */
@Composable
internal fun WorkspaceScreen(
	repo: ChatRepository,
	session: Team?,
	rosterLoaded: Boolean,
	stack: List<WorkspacePlace>,
	onPush: (WorkspacePlace) -> Unit,
	onPop: () -> Unit,
	modifier: Modifier = Modifier,
) {
	if (session == null || !holdsWorkspace(session)) {
		Column(
			modifier.fillMaxSize().padding(24.dp),
			verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
			horizontalAlignment = Alignment.CenterHorizontally,
		) {
			Text(
				if (rosterLoaded) "No workspace" else "No roster yet",
				style = MaterialTheme.typography.titleMedium,
			)
		}
		return
	}
	val target = remember(session.name) { targetOf(session) }
	val place = placeOf(stack)
	val scope = rememberCoroutineScope()
	val boards by repo.windowOps.windows.collectAsState()
	val windows = boards[target].orEmpty()

	Column(modifier.fillMaxSize()) {
		WorkspaceHeader(
			place = place,
			openWindows = windows.size,
			canBack = stack.size > 1,
			onBack = onPop,
			onWindows = { onPush(WorkspacePlace.Windows) },
		)
		when (place) {
			is WorkspacePlace.Tree -> WorkspaceTree(
				ops = repo.windowOps,
				fileOps = repo.fileOps,
				target = target,
				path = place.path,
				onOpenDirectory = { onPush(WorkspacePlace.Tree(it)) },
				onOpenOutline = { onPush(WorkspacePlace.Outline(it)) },
				onOpenRaw = { onPush(WorkspacePlace.Raw(it)) },
			)
			is WorkspacePlace.Outline -> WorkspaceOutline(
				ops = repo.windowOps,
				target = target,
				path = place.path,
				held = windows,
				onOpenDetail = { id, name -> onPush(WorkspacePlace.Detail(id, name)) },
				onOpenWindow = { id -> scope.launch { repo.windowOps.openWindow(target, id) } },
				onOpenRaw = { onPush(WorkspacePlace.Raw(place.path)) },
				onOpenWindows = { onPush(WorkspacePlace.Windows) },
			)
			is WorkspacePlace.Raw -> WorkspaceRawFile(repo.rawFileOps, target, place.path)
			is WorkspacePlace.Detail -> SymbolDetail(
				ops = repo.windowOps,
				target = target,
				symbolId = place.symbolId,
				onOpenWindow = {
					scope.launch { repo.windowOps.openWindow(target, place.symbolId) }
					onPush(WorkspacePlace.Windows)
				},
			)
			WorkspacePlace.Windows -> WindowView(
				ops = repo.windowOps,
				target = target,
				windows = windows,
				onClose = { repo.windowOps.closeWindow(target, it) },
			)
		}
	}
}

@Composable
private fun WorkspaceHeader(
	place: WorkspacePlace,
	openWindows: Int,
	canBack: Boolean,
	onBack: () -> Unit,
	onWindows: () -> Unit,
) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		if (canBack) TextButton(onClick = hapticClick(onBack)) { Text("Back") }
		Text(
			placeTitle(place),
			Modifier.weight(1f),
			style = MaterialTheme.typography.titleSmall,
			fontFamily = FontFamily.Monospace,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
		)
		if (openWindows > 0 && place != WorkspacePlace.Windows) {
			TextButton(onClick = hapticClick(onWindows)) { Text("$openWindows open") }
		}
	}
}

/** The four outcomes of a read, drawn once rather than on each screen. */
@Composable
internal fun <T> WorkspaceAnswerBox(
	answer: WorkspaceAnswer<T>?,
	modifier: Modifier = Modifier,
	content: @Composable (T) -> Unit,
) {
	when (answer) {
		null -> Box(modifier.fillMaxWidth().padding(24.dp), Alignment.Center) { CircularProgressIndicator() }
		// Boxed so the caller's weight reaches the content, or a filling child pushes a footer off screen.
		is WorkspaceAnswer.Read -> Box(modifier) { content(answer.value) }
		is WorkspaceAnswer.Refused -> WorkspaceNotice(answer.reason, modifier)
		WorkspaceAnswer.Unreachable -> WorkspaceNotice("This session could not be reached", modifier)
	}
}

@Composable
internal fun WorkspaceNotice(text: String, modifier: Modifier = Modifier) {
	OutlinedCard(modifier.fillMaxWidth().padding(12.dp)) {
		Text(text, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
	}
}

/** Normal tap opens, long press opens a window. */
@Composable
internal fun WorkspaceRow(
	onClick: () -> Unit,
	onLongClick: (() -> Unit)?,
	modifier: Modifier = Modifier,
	content: @Composable () -> Unit,
) {
	Box(
		modifier.fillMaxWidth().combinedClickable(
			onClick = hapticClick(onClick),
			onLongClick = onLongClick?.let { hapticClick(it) },
		),
	) {
		content()
	}
}
