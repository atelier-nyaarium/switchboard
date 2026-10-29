package com.atelier_nyaarium.switchboard.assistant

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ThreadRendererPool
import com.atelier_nyaarium.switchboard.ThreadWebView
import com.atelier_nyaarium.switchboard.setDraftText
import com.atelier_nyaarium.switchboard.unreadBoundary

/** The panel over another app: the assistant's thread, the screen chip and a composer. */
@Composable
internal fun AssistantPanel(
	repo: ChatRepository,
	pool: ThreadRendererPool,
	team: String,
	/** Bumped per show: re-snaps the thread and raises the keyboard. */
	showing: Int,
	chip: ScreenChip,
	thumbnail: Bitmap?,
	onAttach: (Boolean) -> Unit,
	onSend: () -> Unit,
	onOpenInApp: () -> Unit,
	onClose: () -> Unit,
) {
	val state by repo.state.collectAsState()
	val draft = state.drafts[team]
	val text = draft?.text.orEmpty()
	val sendable = text.isNotBlank() || chip == ScreenChip.ATTACHED
	val focus = remember { FocusRequester() }
	val keyboard = LocalSoftwareKeyboardController.current
	LaunchedEffect(showing) {
		focus.requestFocus()
		keyboard?.show()
	}
	Box(Modifier.fillMaxSize()) {
		Box(
			Modifier
				.fillMaxSize()
				.background(Color.Black.copy(alpha = 0.32f))
				.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClose),
		)
		Surface(
			modifier = Modifier
				.align(Alignment.BottomCenter)
				.fillMaxWidth()
				.fillMaxHeight(0.7f)
				.imePadding()
				.navigationBarsPadding(),
			shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
			tonalElevation = 3.dp,
		) {
			Column(Modifier.fillMaxSize()) {
				Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
					Text("Assistant", style = MaterialTheme.typography.titleMedium)
					Spacer(Modifier.weight(1f))
					TextButton(onClick = onOpenInApp) { Text("Open in app ↗") }
				}
				ThreadWebView(
					team = team,
					messages = state.threads[team].orEmpty(),
					rendererPool = pool,
					openNonce = showing,
					unreadBoundary = { repo.unreadBoundary(it) },
					revealAt = null,
					onRevealed = {},
					composerOccupied = text.isNotBlank(),
					modifier = Modifier.weight(1f).fillMaxWidth(),
				)
				when (chip) {
					ScreenChip.NONE -> Unit
					ScreenChip.OFFER -> InputChip(
						selected = false,
						onClick = { onAttach(true) },
						label = { Text("Share screen") },
						leadingIcon = thumbnail?.let { shot ->
							{
								Image(
									bitmap = shot.asImageBitmap(),
									contentDescription = null,
									contentScale = ContentScale.Crop,
									modifier = Modifier.size(20.dp),
								)
							}
						},
						modifier = Modifier.padding(horizontal = 12.dp),
					)
					ScreenChip.ATTACHED -> InputChip(
						selected = true,
						onClick = { onAttach(false) },
						label = { Text("Screen attached ✕") },
						modifier = Modifier.padding(horizontal = 12.dp),
					)
				}
				Row(
					Modifier.fillMaxWidth().padding(12.dp),
					verticalAlignment = Alignment.CenterVertically,
					horizontalArrangement = Arrangement.spacedBy(8.dp),
				) {
					OutlinedTextField(
						value = text,
						onValueChange = { repo.setDraftText(team, it) },
						placeholder = { Text("Message the assistant") },
						maxLines = 4,
						modifier = Modifier.weight(1f).focusRequester(focus),
					)
					IconButton(onClick = onSend, enabled = sendable) {
						Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
					}
				}
			}
		}
	}
}
