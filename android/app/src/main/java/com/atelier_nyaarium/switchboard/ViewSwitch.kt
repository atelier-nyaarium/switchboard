package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/** How a session is shown, in its bar. One view draws nothing. */
@Composable
internal fun ViewSwitch(views: List<ConversationView>, shown: ConversationView, onView: (ConversationView) -> Unit) {
	if (views.size < 2) return
	val colors = MaterialTheme.colorScheme
	Surface(shape = RoundedCornerShape(18.dp), color = Color.Transparent, border = BorderStroke(1.dp, colors.outlineVariant)) {
		Row(Modifier.height(SEGMENT_HEIGHT).selectableGroup()) {
			views.forEachIndexed { index, view ->
				if (index > 0) VerticalDivider(color = colors.outlineVariant)
				val selected = view == shown
				Box(
					Modifier
						.width(SEGMENT_WIDTH)
						.height(SEGMENT_HEIGHT)
						.background(if (selected) colors.secondaryContainer else Color.Transparent)
						.selectable(selected = selected, role = Role.Tab, onClick = hapticClick { onView(view) }),
					contentAlignment = Alignment.Center,
				) {
					Icon(
						iconOf(view),
						contentDescription = view.title,
						modifier = Modifier.size(18.dp),
						tint = if (selected) colors.onSecondaryContainer else colors.onSurfaceVariant,
					)
				}
			}
		}
	}
}

private val SEGMENT_WIDTH = 38.dp
private val SEGMENT_HEIGHT = 32.dp
