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

/**
 * The two highlights kept from the ref viewer, so one vocabulary covers both surfaces. Blue bands the
 * lines in range; amber names the symbol itself.
 */
internal object Highlight {
	val band = Color(0x33388BFD)
	val mark = Color(0x61D29922)
}

/** The amber mark over the symbol's own name, which is the other half of the ref viewer's vocabulary. */
private fun lineText(line: CodeLine): AnnotatedString =
	buildAnnotatedString {
		append(line.text)
		line.mark?.let { addStyle(SpanStyle(background = Highlight.mark), it.first, it.last + 1) }
	}

/** Wrapping rather than scrolling sideways, which is what the ref viewer's document already does. */
@Composable
internal fun CodeLines(lines: List<CodeLine>, modifier: Modifier = Modifier) {
	Column(modifier.fillMaxWidth()) {
		for (line in lines) {
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
				)
			}
		}
	}
}
