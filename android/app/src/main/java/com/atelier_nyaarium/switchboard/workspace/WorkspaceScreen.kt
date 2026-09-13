package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.Crumb
import com.atelier_nyaarium.switchboard.Team
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspacePlace
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.holdsWorkspace
import com.atelier_nyaarium.switchboard.kindBadge
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
	onJump: (WorkspacePlace) -> Unit,
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
		when (place) {
			is WorkspacePlace.Tree -> WorkspaceTree(
				fileOps = repo.fileOps,
				requests = repo.sessionRequests,
				target = target,
				session = session.shortName,
				path = place.path,
				openWindows = windows.size,
				onOpenDirectory = { onPush(WorkspacePlace.Tree(it)) },
				onOpenFolder = { onJump(WorkspacePlace.Tree(it)) },
				onOpenOutline = { onPush(WorkspacePlace.Outline(it)) },
				onOpenRaw = { onPush(WorkspacePlace.Raw(it)) },
				onOpenWindows = { onPush(WorkspacePlace.Windows) },
			)
			is WorkspacePlace.Outline -> WorkspaceOutline(
				views = repo.symbolViews,
				target = target,
				path = place.path,
				held = windows,
				onOpenFolder = { onJump(WorkspacePlace.Tree(it)) },
				onOpenDetail = { id -> onPush(WorkspacePlace.Detail(id, place.path)) },
				onOpenWindow = { id -> scope.launch { repo.windowOps.openWindow(target, id) } },
				onOpenRaw = { onPush(WorkspacePlace.Raw(place.path)) },
				onOpenWindows = { onPush(WorkspacePlace.Windows) },
			)
			is WorkspacePlace.Raw -> {
				BackLine(placeTitle(place), onPop)
				WorkspaceRawFile(repo.rawFileOps, target, place.path)
			}
			is WorkspacePlace.Detail -> {
				BackLine(placeTitle(place), onPop)
				SymbolDetail(
					views = repo.symbolViews,
					ops = repo.windowOps,
					target = target,
					symbolId = place.symbolId,
					onOpenWindow = {
						scope.launch { repo.windowOps.openWindow(target, place.symbolId) }
						onPush(WorkspacePlace.Windows)
					},
				)
			}
			WorkspacePlace.Windows -> {
				BackLine(placeTitle(place), onPop)
				WindowView(
					ops = repo.windowOps,
					target = target,
					windows = windows,
					onClose = { repo.windowOps.closeWindow(target, it) },
				)
			}
		}
	}
}

@Composable
private fun BackLine(title: String, onBack: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(onClick = hapticClick(onBack)).padding(horizontal = 12.dp, vertical = 12.dp),
		horizontalArrangement = Arrangement.spacedBy(10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", Modifier.size(20.dp))
		Text(
			title,
			style = MaterialTheme.typography.titleSmall,
			fontFamily = FontFamily.Monospace,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
		)
	}
}

/** Every segment opens its folder; `prefix` is the root's parent, drawn dim. */
@Composable
internal fun Breadcrumbs(crumbs: List<Crumb>, prefix: String, onOpenFolder: (String) -> Unit, modifier: Modifier = Modifier) {
	val colors = MaterialTheme.colorScheme
	Row(
		modifier.horizontalScroll(rememberScrollState()),
		verticalAlignment = Alignment.CenterVertically,
	) {
		if (prefix.isNotEmpty()) {
			Text(prefix, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = colors.outline)
		}
		crumbs.forEachIndexed { index, crumb ->
			if (index > 0) {
				Text(" / ", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = colors.outline)
			}
			Text(
				crumb.label,
				Modifier.clickable(onClick = hapticClick { onOpenFolder(crumb.path) }).padding(vertical = 4.dp),
				style = MaterialTheme.typography.labelMedium,
				fontFamily = FontFamily.Monospace,
				fontWeight = if (index == 0 || index == crumbs.lastIndex) FontWeight.SemiBold else FontWeight.Normal,
				color = colors.onSurfaceVariant,
			)
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

@Composable
internal fun KindBadge(symbolKind: String?, modifier: Modifier = Modifier) {
	val letter = kindBadge(symbolKind)
	val colors = MaterialTheme.colorScheme
	val (container, content) = when (letter) {
		"F" -> colors.primaryContainer to colors.onPrimaryContainer
		"C" -> colors.tertiaryContainer to colors.onTertiaryContainer
		"T", "K" -> colors.secondaryContainer to colors.onSecondaryContainer
		else -> colors.surfaceVariant to colors.onSurfaceVariant
	}
	Box(
		modifier.size(22.dp).background(container, RoundedCornerShape(5.dp)),
		contentAlignment = Alignment.Center,
	) {
		Text(letter, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = content)
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
