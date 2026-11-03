package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.ScrollState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Place before `verticalScroll`. */
internal fun Modifier.scrollThumb(state: ScrollState, color: Color): Modifier = drawWithContent {
	drawContent()
	val overflow = state.maxValue
	if (overflow <= 0 || overflow == Int.MAX_VALUE) return@drawWithContent
	val viewport = size.height
	val thumb = (viewport * viewport / (viewport + overflow)).coerceAtLeast(24.dp.toPx())
	val top = (viewport - thumb) * state.value / overflow
	val width = 3.dp.toPx()
	drawRoundRect(
		color = color,
		topLeft = Offset(size.width - width, top),
		size = Size(width, thumb),
		cornerRadius = CornerRadius(width / 2f),
	)
}
