package com.atelier_nyaarium.switchboard

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal data class CometSpan(val start: Float, val end: Float, val alpha: Float)

@Composable
internal fun ComposerField(
	value: String,
	onValueChange: (String) -> Unit,
	working: Boolean,
	modifier: Modifier = Modifier,
	label: (@Composable () -> Unit)? = null,
	placeholder: (@Composable () -> Unit)? = null,
	minLines: Int = 1,
	maxLines: Int = Int.MAX_VALUE,
) {
	val shape = OutlinedTextFieldDefaults.shape
	// Comet replaces the border.
	val colors = if (working) {
		val resting = MaterialTheme.colorScheme.outlineVariant
		OutlinedTextFieldDefaults.colors(focusedBorderColor = resting, unfocusedBorderColor = resting)
	} else {
		OutlinedTextFieldDefaults.colors()
	}
	OutlinedTextField(
		value = value,
		onValueChange = onValueChange,
		shape = shape,
		colors = colors,
		label = label,
		placeholder = placeholder,
		minLines = minLines,
		maxLines = maxLines,
		modifier = modifier.workingComet(working, shape, if (label != null) LABEL_FLOAT_INSET else 0.dp),
	)
}

/** Label border offset. */
private val LABEL_FLOAT_INSET = 8.dp

internal fun cometSpans(
	progress: Float,
	length: Float,
	tailFraction: Float = 0.18f,
	parts: Int = 12,
): List<CometSpan> {
	if (!progress.isFinite() || !length.isFinite() || length <= 0f || parts <= 0) return emptyList()
	if (!tailFraction.isFinite() || tailFraction <= 0f) return emptyList()
	val tailLength = length * tailFraction.coerceAtMost(1f)
	if (tailLength <= 0f) return emptyList()
	val head = progress.coerceIn(0f, 1f) * length
	val partLength = tailLength / parts
	if (partLength <= 0f) return emptyList()
	return buildList {
		repeat(parts) { index ->
			val end = head - index * partLength
			val start = end - partLength
			val alpha = 1f - index.toFloat() / parts
			if (start >= 0f) {
				if (start < end) add(CometSpan(start, end, alpha))
			} else if (end <= 0f) {
				val wrappedStart = start + length
				val wrappedEnd = end + length
				if (wrappedStart < wrappedEnd) add(CometSpan(wrappedStart, wrappedEnd, alpha))
			} else {
				if (0f < end) add(CometSpan(0f, end, alpha))
				val wrappedStart = start + length
				if (wrappedStart < length) add(CometSpan(wrappedStart, length, alpha))
			}
		}
	}
}

internal fun Modifier.workingComet(active: Boolean, shape: Shape, topInset: Dp = 0.dp): Modifier = composed {
	if (!active) {
		this
	} else {
		val transition = rememberInfiniteTransition(label = "workingComet")
		val progress by transition.animateFloat(
			initialValue = 0f,
			targetValue = 1f,
			animationSpec = infiniteRepeatable(
				animation = tween(durationMillis = 2400, easing = LinearEasing),
				repeatMode = RepeatMode.Restart,
			),
			label = "workingCometProgress",
		)
		val color = MaterialTheme.colorScheme.primary
		this.drawWithCache {
			val strokeWidth = 2.dp.toPx()
			val inset = strokeWidth / 2f
			val top = topInset.toPx()
			val outline = shape.createOutline(
				Size(size.width - strokeWidth, size.height - strokeWidth - top),
				layoutDirection,
				this,
			)
			val path = Path()
			when (outline) {
				is Outline.Rounded -> path.addRoundRect(outline.roundRect)
				is Outline.Rectangle -> path.addRect(outline.rect)
				is Outline.Generic -> path.addPath(outline.path)
			}
			path.translate(Offset(inset, inset + top))
			val pathMeasure = PathMeasure().apply { setPath(path, false) }
			val pathLength = pathMeasure.length
			val segmentPath = Path()
			// Caps overlap into dots.
			val tail = Stroke(width = strokeWidth, cap = StrokeCap.Butt)
			val head = Stroke(width = strokeWidth, cap = StrokeCap.Round)
			onDrawWithContent {
				drawContent()
				cometSpans(progress, pathLength).asReversed().forEach { span ->
					segmentPath.rewind()
					if (pathMeasure.getSegment(span.start, span.end, segmentPath, true)) {
						drawPath(segmentPath, color.copy(alpha = span.alpha), style = if (span.alpha >= 1f) head else tail)
					}
				}
			}
		}
	}
}
