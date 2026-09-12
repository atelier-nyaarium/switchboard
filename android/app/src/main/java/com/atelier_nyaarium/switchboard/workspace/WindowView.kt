package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.Applied
import com.atelier_nyaarium.switchboard.Window
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.editedWindows
import com.atelier_nyaarium.switchboard.gapBetween
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.inFileOrder
import com.atelier_nyaarium.switchboard.modulesOf
import com.atelier_nyaarium.switchboard.neighbourBounds
import com.atelier_nyaarium.switchboard.opensModule
import com.atelier_nyaarium.switchboard.windowParts
import kotlinx.coroutines.launch

/**
 * The open windows down one scroll, each with the file either side of it read-only. The file is read
 * once per module for that context; a module that cannot be read draws its spans alone.
 */
@Composable
internal fun WindowView(
	ops: WindowOps,
	target: WorkspaceTarget,
	windows: List<Window>,
	onClose: (String) -> Unit,
	modifier: Modifier = Modifier,
) {
	val ordered = inFileOrder(windows)
	val modules = modulesOf(ordered)
	var context by remember(target.key) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
	val scope = rememberCoroutineScope()

	LaunchedEffect(target.key, modules) {
		for (module in modules) {
			ops.contextFor(target, module)?.let { context = context + (module to it) }
		}
	}

	if (ordered.isEmpty()) {
		WorkspaceNotice("Long press a symbol in an outline to open a window", modifier)
		return
	}

	val edits = editedWindows(ordered).size
	var asked by remember(target.key) { mutableStateOf<Applied?>(null) }
	var asking by remember(target.key) { mutableStateOf(false) }

	Column(modifier.fillMaxSize()) {
		WindowScroll(ops, target, ordered, context, Modifier.weight(1f), onClose)
		asked?.let { WorkspaceNotice(appliedNotice(it)) }
		if (edits > 0) {
			OutlinedButton(
				// Guarded, or a second tap asks twice for the same spans while the first is still going.
				onClick = hapticClick {
					if (!asking) {
						asking = true
						// Finally, or a cancellation leaves the button disabled with nothing said.
						scope.launch {
							try {
								asked = ops.agentApply(target)
							} finally {
								asking = false
							}
						}
					}
				},
				enabled = !asking,
				modifier = Modifier.fillMaxWidth().padding(12.dp),
			) {
				Text(if (edits == 1) "Agent Apply" else "Agent Apply $edits spans")
			}
		}
	}
}

/**
 * What the owner is told. A send that left the phone is not an apply that happened, so this says
 * where to look rather than claiming an outcome: the thread carries the agent's reply, and a message
 * that failed to leave shows its own error there.
 */
private fun appliedNotice(applied: Applied): String =
	when (applied) {
		is Applied.Sent -> if (applied.spans == 1) "Asked. The agent answers in the thread." else
			"Asked about ${applied.spans} spans. The agent answers in the thread."
		Applied.NothingEdited -> "Nothing to ask about"
		Applied.Failed -> "That did not leave the phone"
	}

@Composable
private fun WindowScroll(
	ops: WindowOps,
	target: WorkspaceTarget,
	ordered: List<Window>,
	context: Map<String, List<String>>,
	modifier: Modifier,
	onClose: (String) -> Unit,
) {
	val scope = rememberCoroutineScope()

	LazyColumn(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		for ((index, window) in ordered.withIndex()) {
			val (previousEnd, nextStart) = neighbourBounds(ordered, index)
			if (opensModule(ordered, index)) {
				item(key = "module:${window.descriptor.module}") {
					Text(
						window.descriptor.module,
						Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
						style = MaterialTheme.typography.labelSmall,
						fontFamily = FontFamily.Monospace,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			} else {
				gapBetween(ordered[index - 1], window)?.let { skipped ->
					item(key = "gap:${window.descriptor.symbolId}") { GapRow(skipped) }
				}
			}
			item(key = "window:${window.descriptor.symbolId}") {
				WindowCard(
					window = window,
					file = context[window.descriptor.module],
					previousEnd = previousEnd,
					nextStart = nextStart,
					onType = { ops.type(target, window.descriptor.symbolId, it) },
					onRefresh = { scope.launch { ops.adopt(target, window.descriptor.symbolId) } },
					onClose = { onClose(window.descriptor.symbolId) },
				)
			}
		}
	}
}

@Composable
private fun GapRow(skipped: Int) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 16.dp),
		horizontalArrangement = Arrangement.spacedBy(8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		HorizontalDivider(Modifier.weight(1f))
		Text(
			if (skipped == 1) "1 line" else "$skipped lines",
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		HorizontalDivider(Modifier.weight(1f))
	}
}

/**
 * The span itself, in the purple the design reserves for what is editable.
 *
 * The selection is held here and saved, because the text alone is not the field's state: scrolling
 * the card off screen disposes it, and rebuilding from a bare string puts the caret at the end, where
 * the next keystroke lands somewhere the owner did not choose. A change from elsewhere, which is a
 * refresh or an adopt, replaces the whole value; that window is no longer theirs to be typing in.
 */
@Composable
private fun SpanField(key: String, text: String, onType: (String) -> Unit) {
	var value by rememberSaveable(key, stateSaver = TextFieldValue.Saver) {
		mutableStateOf(TextFieldValue(text))
	}
	if (value.text != text) value = TextFieldValue(text, TextRange(text.length))

	OutlinedTextField(
		value = value,
		onValueChange = {
			value = it
			onType(it.text)
		},
		modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
		textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
		colors = OutlinedTextFieldDefaults.colors(
			focusedBorderColor = MaterialTheme.colorScheme.primary,
			unfocusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.4f),
		),
	)
}

@Composable
private fun WindowCard(
	window: Window,
	file: List<String>?,
	previousEnd: Int?,
	nextStart: Int?,
	onType: (String) -> Unit,
	onRefresh: () -> Unit,
	onClose: () -> Unit,
) {
	Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
		Column(Modifier.fillMaxWidth()) {
			Row(
				Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, end = 4.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text(
					window.descriptor.name,
					Modifier.weight(1f),
					style = MaterialTheme.typography.titleSmall,
					fontFamily = FontFamily.Monospace,
					maxLines = 1,
					overflow = TextOverflow.Ellipsis,
				)
				if (window.edited) {
					Text(
						"EDITED",
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.primary,
					)
				}
				Text(
					"${window.descriptor.startLine}-${window.descriptor.endLine}",
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				TextButton(onClick = hapticClick(onClose)) { Text("Close") }
			}
			if (window.stale) {
				OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
					Row(
						Modifier.fillMaxWidth().padding(start = 12.dp),
						horizontalArrangement = Arrangement.spacedBy(8.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
							Text("Stale Window", style = MaterialTheme.typography.labelLarge)
							Text("The code here changed.", style = MaterialTheme.typography.bodySmall)
						}
						TextButton(onClick = hapticClick(onRefresh)) { Text("Refresh") }
					}
				}
			}
			val parts = windowParts(window, file, previousEnd = previousEnd, nextStart = nextStart)
			CodeLines(parts.above, Modifier.padding(top = 6.dp))
			SpanField(window.descriptor.symbolId, parts.span, onType)
			CodeLines(parts.below, Modifier.padding(bottom = 6.dp))
		}
	}
}
