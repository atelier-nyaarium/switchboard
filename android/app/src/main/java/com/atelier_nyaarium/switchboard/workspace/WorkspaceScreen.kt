package com.atelier_nyaarium.switchboard.workspace

import androidx.activity.compose.BackHandler
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.WORKSPACE_ROOT
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspacePlace
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.localFieldOf
import com.atelier_nyaarium.switchboard.pickedSession
import com.atelier_nyaarium.switchboard.placeOf
import com.atelier_nyaarium.switchboard.placeTitle
import com.atelier_nyaarium.switchboard.popPlace
import com.atelier_nyaarium.switchboard.pushPlace
import com.atelier_nyaarium.switchboard.targetOf
import com.atelier_nyaarium.switchboard.workspaceSessions
import kotlinx.coroutines.launch

/**
 * The Files tab: one session's workspace, with the tree, a file's outline, a symbol's detail and the
 * open windows behind one Back stack.
 *
 * Every rule is in `WorkspaceNav.kt` and `WindowRules.kt`. Nothing here decides anything, since there
 * is no instrumentation source set for a gate to reach a decision made inside a Composable.
 */
@Composable
fun WorkspaceScreen(repo: ChatRepository, state: ChatState, modifier: Modifier = Modifier) {
	val sessions = remember(state.teams) { workspaceSessions(state.teams) }
	var pickedName by remember { mutableStateOf<String?>(null) }
	val session = pickedSession(sessions, pickedName)

	Column(modifier.fillMaxSize()) {
		if (sessions.size > 1) {
			Box(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
				PickMenu(
					label = "Session",
					choices = sessions,
					picked = session,
					labelOf = { it.sessionLabel ?: localFieldOf(it.name) },
					onPick = { pickedName = it.name },
					trailingOf = { it.gatewayId },
				)
			}
		}
		if (session == null) {
			Column(
				Modifier.fillMaxSize().padding(24.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				Text(
					if (state.gateways.loaded) "No sessions" else "No roster yet",
					style = MaterialTheme.typography.titleMedium,
				)
			}
		} else {
			val target = remember(session.name) { targetOf(session) }
			WorkspaceNavHost(repo, target, Modifier.weight(1f))
		}
	}
}

@Composable
private fun WorkspaceNavHost(repo: ChatRepository, target: WorkspaceTarget, modifier: Modifier = Modifier) {
	// Switching session starts over: a held path names the workspace it was read from.
	var stack by remember(target.key) { mutableStateOf(listOf(WORKSPACE_ROOT)) }
	val place = placeOf(stack)
	val scope = rememberCoroutineScope()
	val boards by repo.windowOps.windows.collectAsState()
	val windows = boards[target].orEmpty()

	BackHandler(enabled = stack.size > 1) { stack = popPlace(stack) }

	Column(modifier.fillMaxSize()) {
		WorkspaceHeader(
			place = place,
			openWindows = windows.size,
			canBack = stack.size > 1,
			onBack = { stack = popPlace(stack) },
			onWindows = { stack = pushPlace(stack, WorkspacePlace.Windows) },
		)
		when (place) {
			is WorkspacePlace.Tree -> WorkspaceTree(
				ops = repo.windowOps,
				target = target,
				path = place.path,
				onOpenDirectory = { stack = pushPlace(stack, WorkspacePlace.Tree(it)) },
				onOpenOutline = { stack = pushPlace(stack, WorkspacePlace.Outline(it)) },
				onOpenRaw = { stack = pushPlace(stack, WorkspacePlace.Raw(it)) },
			)
			is WorkspacePlace.Outline -> WorkspaceOutline(
				ops = repo.windowOps,
				target = target,
				path = place.path,
				held = windows,
				onOpenDetail = { id, name -> stack = pushPlace(stack, WorkspacePlace.Detail(id, name)) },
				onOpenWindow = { id -> scope.launch { repo.windowOps.openWindow(target, id) } },
				onOpenRaw = { stack = pushPlace(stack, WorkspacePlace.Raw(place.path)) },
				onOpenWindows = { stack = pushPlace(stack, WorkspacePlace.Windows) },
			)
			is WorkspacePlace.Raw -> WorkspaceRawFile(repo.windowOps, target, place.path)
			is WorkspacePlace.Detail -> SymbolDetail(
				ops = repo.windowOps,
				target = target,
				symbolId = place.symbolId,
				onOpenWindow = {
					scope.launch { repo.windowOps.openWindow(target, place.symbolId) }
					stack = pushPlace(stack, WorkspacePlace.Windows)
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

/**
 * The four outcomes of a read, drawn once rather than on each screen: still reading, the gateway's own
 * refusal, no word at all, and the answer.
 */
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

/** Normal tap opens, long press opens a window, which is the one gesture rule these lists share. */
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
