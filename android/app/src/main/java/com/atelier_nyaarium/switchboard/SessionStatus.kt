package com.atelier_nyaarium.switchboard

// The one vocabulary for a session's status words and colors.

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

////////////////////////////////
//  Composables

/** Chip color for the board/thread presence vocabulary. */
@Composable
internal fun presenceColor(word: SessionWord): Color = when (word) {
	SessionWord.LIVE -> STATUS_GREEN
	SessionWord.WORKING, SessionWord.WAKING, SessionWord.VERIFYING -> STATUS_AMBER
	SessionWord.AVAILABLE -> Color(0xFF0969DA)
	SessionWord.CHECK_TERMINAL, SessionWord.LIMIT_HIT -> Color(0xFFDA3633)
	SessionWord.ENDED -> MaterialTheme.colorScheme.outline
}

@Composable
internal fun StatusChip(text: String, color: Color) {
	Surface(color = color.copy(alpha = 0.16f), shape = MaterialTheme.shapes.small) {
		Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.size(7.dp).clip(CircleShape).background(color))
			Spacer(Modifier.width(5.dp))
			Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
		}
	}
}
