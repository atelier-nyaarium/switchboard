package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Three rising bars, `level` of them lit. */
@Composable
internal fun SignalBars(level: Int, modifier: Modifier = Modifier) {
	val lit = MaterialTheme.colorScheme.onSurface
	val dim = MaterialTheme.colorScheme.outlineVariant
	Canvas(modifier.size(18.dp).semantics { contentDescription = "Signal $level of 3" }) {
		val gap = size.width / 9f
		val width = (size.width - gap * 2) / 3f
		for (bar in 0 until 3) {
			val height = size.height * (bar + 1) / 3f
			drawRoundRect(
				color = if (bar < level) lit else dim,
				topLeft = Offset(bar * (width + gap), size.height - height),
				size = Size(width, height),
				cornerRadius = CornerRadius(width / 4f),
			)
		}
	}
}
