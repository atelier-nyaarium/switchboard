package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.CodeLine

/** Blue bands the lines in range; amber names the symbol. The ref viewer's two colours. */
internal object Highlight {
	val band = Color(0x33388BFD)
	val mark = Color(0x61D29922)
}

private fun lineText(line: CodeLine): AnnotatedString =
	buildAnnotatedString {
		append(line.text)
		line.mark?.let { addStyle(SpanStyle(background = Highlight.mark), it.first, it.last + 1) }
	}

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
