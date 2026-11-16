package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.CodePalette
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.liveconsole.AssistRows
import com.atelier_nyaarium.switchboard.liveconsole.CODE
import com.atelier_nyaarium.switchboard.liveconsole.VariableShape
import com.atelier_nyaarium.switchboard.liveconsole.applyTo
import com.atelier_nyaarium.switchboard.liveconsole.paintedCode
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleIds

private val PROSE_KEYBOARD = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
private val TEXT_STYLE = CODE.copy(fontSize = 15.sp, lineHeight = 22.sp)

private class HoleHighlight(
	private val entities: Set<String>,
	private val names: Set<String>,
	private val issue: IntRange?,
) : VisualTransformation {
	override fun filter(text: AnnotatedString) =
		TransformedText(paintedCode(text.text, holePaint(text.text, entities, names), issue), OffsetMapping.Identity)
}

/** Writes through, so Back keeps it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HoleTextEditor(
	title: String,
	value: String,
	max: Int,
	names: List<NameHere>,
	preview: TextPreview,
	refused: AutomationSaid.Hole?,
	description: ConsoleDescription?,
	ids: ConsoleIds?,
	shapes: Map<String, VariableShape?>,
	enabled: Boolean,
	onChange: (String) -> Unit,
	onBack: () -> Unit,
) {
	var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
	val entities = remember(description) { description?.entities?.map { it.name }?.toSet().orEmpty() }
	val named = remember(names) { names.map { it.name }.toSet() }
	val assist = remember(field.text, field.selection, description, ids, shapes) {
		holeAssist(field.text, field.selection.start, description, ids, shapes)
	}
	val issue = refusedSpan(field.text, preview, refused)
	val focus = remember { FocusRequester() }
	LaunchedEffect(Unit) { focus.requestFocus() }

	fun edit(next: TextFieldValue) {
		if (next.text != field.text) onChange(next.text)
		field = next
	}

	fun place(inserted: Pair<String, Int>) {
		edit(TextFieldValue(inserted.first, TextRange(inserted.second)))
		focus.requestFocus()
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(title) },
				navigationIcon = {
					IconButton(onClick = hapticClick(onBack)) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
					}
				},
			)
		},
	) { padding ->
		Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
			Column(
				Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp),
				verticalArrangement = Arrangement.spacedBy(12.dp),
			) {
				BasicTextField(
					value = field,
					onValueChange = ::edit,
					enabled = enabled,
					textStyle = TEXT_STYLE,
					cursorBrush = SolidColor(Color(CodePalette.TEXT)),
					visualTransformation = remember(entities, named, issue) { HoleHighlight(entities, named, issue) },
					keyboardOptions = PROSE_KEYBOARD,
					modifier =
						Modifier.fillMaxWidth()
							.focusRequester(focus)
							.heightIn(min = 132.dp)
							.background(Color(CodePalette.BACKGROUND), RoundedCornerShape(12.dp))
							.border(1.dp, Color(CodePalette.BORDER), RoundedCornerShape(12.dp))
							.padding(14.dp),
				)
				Text(
					"${field.text.length} / $max",
					style = MaterialTheme.typography.labelSmall,
					color = if (field.text.length > max) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
					textAlign = TextAlign.End,
					modifier = Modifier.fillMaxWidth(),
				)
				TextPreviewBlock(field.text, preview, refused)
				NamesCard(
					names = names,
					description = description,
					enabled = enabled,
					onName = { name -> place(withName(field.text, field.selection.start, name)) },
					onEntity = { name -> place(withEntity(field.text, field.selection.start, name)) },
				)
			}
			AssistRows(assist) { completion ->
				val (text, cursor) = completion.applyTo(field.text)
				edit(TextFieldValue(text, TextRange(cursor)))
			}
		}
	}
}

/** Trigger names, then Console entities. */
@Composable
private fun NamesCard(
	names: List<NameHere>,
	description: ConsoleDescription?,
	enabled: Boolean,
	onName: (String) -> Unit,
	onEntity: (String) -> Unit,
) {
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	val entities = description?.entities.orEmpty()
	if (names.isEmpty() && entities.isEmpty()) return
	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(vertical = 12.dp)) {
			Text("Names here", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 12.dp))
			for (name in names) {
				NameRow("{${name.name}}", name.says, enabled) { onName(name.name) }
			}
			if (entities.isNotEmpty()) {
				Text(
					"From the Console",
					style = MaterialTheme.typography.labelSmall,
					color = dim,
					modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
				)
				for (entity in entities) {
					NameRow(entity.name, entity.description, enabled) { onEntity(entity.name) }
				}
			}
		}
	}
}

@Composable
private fun NameRow(name: String, says: String, enabled: Boolean, onPick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = hapticClick(onPick)).padding(horizontal = 12.dp, vertical = 8.dp),
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Text(name, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
		Text(
			says,
			style = MaterialTheme.typography.bodyMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
	}
}
