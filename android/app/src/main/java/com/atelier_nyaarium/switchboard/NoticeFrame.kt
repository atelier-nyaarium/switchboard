package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier

/**
 * The shell's notices take their own strip at the top of the window and push the screen down, so
 * they cover nothing. The strip pads for the status bar and consumes it for the screen below.
 */
@Composable
internal fun NoticeFrame(repo: ChatRepository, at: NoticeAt, content: @Composable () -> Unit) {
	val state by repo.state.collectAsState()
	val lines = shellNoticeLines(state.notices, at) { tabLabelFor(state, it) }
	Column(Modifier.fillMaxSize()) {
		if (lines.isNotEmpty()) {
			Box(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
				NoticeStack(lines, repo::dismissNotice, repo::clearNotices)
			}
		}
		val below = if (lines.isEmpty()) Modifier else Modifier.consumeWindowInsets(WindowInsets.statusBars)
		Box(Modifier.weight(1f).fillMaxWidth().then(below)) { content() }
	}
}
