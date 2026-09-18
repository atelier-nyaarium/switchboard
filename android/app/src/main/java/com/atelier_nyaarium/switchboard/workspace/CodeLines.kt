package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.CodeLine
import com.atelier_nyaarium.switchboard.CodePalette
import com.atelier_nyaarium.switchboard.Expanded
import com.atelier_nyaarium.switchboard.PaintRun
import com.atelier_nyaarium.switchboard.PaintedLine
import com.atelier_nyaarium.switchboard.RawPaint
import com.atelier_nyaarium.switchboard.expandTabs
import com.atelier_nyaarium.switchboard.paintRuns

/** Blue bands the lines in range; amber names the symbol. The ref viewer's two colours. */
internal object Highlight {
	val band = Color(0x33388BFD)
	val mark = Color(0x61D29922)
}

private fun lineText(line: CodeLine): AnnotatedString = paintedAnnotated(expandTabs(line.text), line.runs, mark = line.mark)

/** Wraps rather than scrolling sideways. */
@Composable
internal fun CodeLineRow(line: CodeLine) {
	Row(
		Modifier.fillMaxWidth()
			.background(if (line.banded) Highlight.band else Color.Transparent)
			.padding(vertical = 1.dp),
	) {
		Text(
			"${line.number}",
			Modifier.width(38.dp).padding(end = 8.dp),
			style = MaterialTheme.typography.bodySmall,
			fontFamily = FontFamily.Monospace,
			fontSize = 11.sp,
			textAlign = TextAlign.End,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Text(
			lineText(line),
			Modifier.weight(1f).padding(end = 8.dp),
			style = MaterialTheme.typography.bodySmall,
			fontFamily = FontFamily.Monospace,
			fontSize = 11.sp,
			// Dimmed beside an editable field, so what the owner cannot change reads that way.
			color = if (line.banded) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
}

/** Eager, so it belongs inside a window card and never over a whole file. */
@Composable
internal fun CodeLines(lines: List<CodeLine>, modifier: Modifier = Modifier) {
	Column(modifier.fillMaxWidth()) {
		for (line in lines) CodeLineRow(line)
	}
}

private const val CODE_SIZE = 10.5f

private const val USE_CODE_SIZE = 11f

private const val NUMBER_COLUMN = 34

internal fun annotatedOf(line: PaintedLine): AnnotatedString = paintedAnnotated(expandTabs(line.text), line.runs, hit = line.hit)

/** Paints runs, hits, and marks. */
internal fun paintedAnnotated(
	expanded: Expanded,
	runs: List<PaintRun>,
	hit: IntRange? = null,
	mark: IntRange? = null,
): AnnotatedString =
	buildAnnotatedString {
		append(expanded.text)
		for (run in runs) {
			val style = CodePalette.styleOf(run.token)
			addStyle(
				SpanStyle(
					color = Color(style.argb),
					fontWeight = if (style.bold) FontWeight.Bold else null,
					fontStyle = if (style.italic) FontStyle.Italic else null,
					background = style.background?.let { Color(it) } ?: Color.Unspecified,
				),
				expanded.expandedOffset(run.start),
				expanded.expandedOffset(run.end),
			)
		}
		// Underlined rather than recoloured, so the name keeps its token's colour.
		hit?.let { addStyle(SpanStyle(textDecoration = TextDecoration.Underline), expanded.expandedOffset(it.first), expanded.expandedOffset(it.last + 1)) }
		mark?.let { addStyle(SpanStyle(background = Highlight.mark), expanded.expandedOffset(it.first), expanded.expandedOffset(it.last + 1)) }
	}

/** Tab runs map to their tab. */
internal fun tabOffsetMapping(expanded: Expanded): OffsetMapping =
	object : OffsetMapping {
		override fun originalToTransformed(offset: Int): Int = expanded.expandedOffset(offset)

		override fun transformedToOriginal(offset: Int): Int = expanded.originalOffset(offset)
	}

/** Stale paint draws plain. */
internal fun paintTransformation(paint: RawPaint?): VisualTransformation =
	VisualTransformation { text ->
		val expanded = expandTabs(text.text)
		val runs = if (paint != null && paint.text == text.text) paintRuns(paint) else emptyList()
		TransformedText(paintedAnnotated(expanded, runs), tabOffsetMapping(expanded))
	}

/** One source line, numbered, with the amber band on the line a use reached. */
@Composable
internal fun PaintedCodeRow(line: PaintedLine, numbered: Boolean, modifier: Modifier = Modifier) {
	val text = remember(line) { annotatedOf(line) }
	Row(
		modifier.fillMaxWidth()
			.height(IntrinsicSize.Min)
			.background(if (line.marked) Color(CodePalette.MARK_BAND) else Color.Transparent),
	) {
		if (numbered) {
			MarkBar(line.marked)
			// The same trimmed style, or the number sets a taller row than the code beside it.
			Text(
				"${line.number ?: ""}",
				Modifier.width(NUMBER_COLUMN.dp).padding(end = 8.dp),
				textAlign = TextAlign.End,
				color = Color(if (line.marked) CodePalette.MARK else CodePalette.LINE_NUMBER),
				style = codeStyle(CODE_SIZE),
			)
		}
		CodeText(text, CODE_SIZE, Modifier.weight(1f))
	}
}

/** The one-line form a use card and a signature draw. */
@Composable
internal fun UseCode(line: PaintedLine, modifier: Modifier = Modifier) {
	val text = remember(line) { annotatedOf(line) }
	CodeText(text, USE_CODE_SIZE, modifier.fillMaxWidth())
}

@Composable
private fun CodeText(text: AnnotatedString, size: Float, modifier: Modifier) {
	Text(
		text,
		modifier,
		color = Color(CodePalette.TEXT),
		maxLines = 1,
		softWrap = false,
		overflow = TextOverflow.Ellipsis,
		style = codeStyle(size),
	)
}

/** Font padding trimmed, or the row stands half a line taller than its line height. */
private fun codeStyle(size: Float): TextStyle =
	TextStyle(
		fontFamily = FontFamily.Monospace,
		fontSize = size.sp,
		lineHeight = (size * 1.6f).sp,
		platformStyle = PlatformTextStyle(includeFontPadding = false),
		lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.Both),
	)

@Composable
private fun MarkBar(marked: Boolean) {
	Box(
		Modifier.width(3.dp)
			.fillMaxHeight()
			.background(if (marked) Color(CodePalette.MARK) else Color.Transparent),
	)
}
