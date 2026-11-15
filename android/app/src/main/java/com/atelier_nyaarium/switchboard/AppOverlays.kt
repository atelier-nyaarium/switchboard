package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

////////////////////////////////
//  Composables

// Opened by intent, so only `ShellOverlays` draws it: that host waits for the lock.
@Composable
internal fun QueueOverlay(
	repo: ChatRepository,
	openQueueRequest: MutableState<Boolean>,
	revealAtState: MutableState<Pair<String, Long>?>,
	openTeamRequest: MutableState<String?>,
) {
	var revealAt by revealAtState
	if (openQueueRequest.value) {
		QueueSheetHost(
			repo = repo,
			onDismiss = { openQueueRequest.value = false },
			onJump = { entry ->
				// Same request as a notification tap, so the open gesture is shared.
				revealAt = entry.team to entry.at
				openTeamRequest.value = entry.team
				openQueueRequest.value = false
			},
		)
	}
}

// Composed after the screens so it overlays them and its BackHandler wins.
@Composable
internal fun AttachmentViewerOverlay(viewerState: MutableState<OpenAttachment?>, rendererPool: ThreadRendererPool) {
	var viewer by viewerState
	viewer?.let { att ->
		AttachmentViewer(
			att = att,
			onOpenWith = {
				rendererPool.openWith(att.relPath)
				viewer = null
			},
			onDismiss = { viewer = null },
		)
	}
}
