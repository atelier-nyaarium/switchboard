package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atelier_nyaarium.switchboard.NoneLine
import com.atelier_nyaarium.switchboard.emptyLine
import com.atelier_nyaarium.switchboard.hapticClick
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/** Maximum label width, dp. */
private const val MAP_LABEL_MAX = 132f

/** Two-line automation label width. */
private const val PILL_LABEL_MAX = 104f
private const val SCALE_MIN = 0.6f
private const val SCALE_MAX = 2f
private val AMBER = Color(0xFFE0A93B)

private data class FlowPalette(val ok: Color, val amber: Color, val red: Color, val faint: Color, val primary: Color, val onPrimary: Color, val card: Color, val label: Color)

@Composable
private fun flowPalette(): FlowPalette = MaterialTheme.colorScheme.let {
	FlowPalette(it.onSurfaceVariant, AMBER, it.error, it.outlineVariant, it.primary, it.onPrimary, it.surface, it.onSurface)
}

private fun FlowPalette.of(colour: FlowColour): Color = when (colour) {
	FlowColour.OK -> ok
	FlowColour.AMBER -> amber
	FlowColour.RED -> red
	FlowColour.FAINT -> faint
}


/** Gateway-specific selection. */
@Composable
internal fun AutomationsMapView(groups: List<AutomationGroup>, onOpen: (String, String) -> Unit) {
	var keyShown by remember { mutableStateOf(false) }
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
		TextButton(onClick = hapticClick { keyShown = true }) { Text("Key") }
	}
	for (group in groups) {
		key(group.gatewayId) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Text(group.gatewayId, style = MaterialTheme.typography.labelLarge)
				if (group.assistant) AssistantChip()
			}
			when (val served = group.context.served) {
				is Served.Known -> FlowBand(
					band = group.gatewayId,
					input = flowInputOf(group.rows, served.offer, group.context.sources),
					offer = served.offer,
					opens = { id -> group.rows.firstOrNull { it.id == id }?.let { opensIn(it, group.context) } == true },
					onOpen = { onOpen(group.gatewayId, it) },
				)
				is Served.Unknown -> Text(
					emptyLine(served.why, "automations"),
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
	}
	if (keyShown) FlowKeyDialog { keyShown = false }
}

@Composable
private fun FlowBand(band: String, input: FlowInput, offer: AutomationOffer, opens: (String) -> Boolean, onOpen: (String) -> Unit) {
	val graph = remember(input) { flowGraph(input) }
	val runs = remember(input.rows) { flowRuns(input.rows) }
	var picked by remember(band) { mutableStateOf<FlowKey?>(null) }
	var replaying by remember(band) { mutableStateOf<Replaying?>(null) }
	val selected = selectionAfter(graph, picked)
	val playing = replaying?.takeIf { selected == FlowKey.Automation(it.id) && replayStands(input.rows, it.id, it.replay.run) }
	val chosen = (selected as? FlowKey.Automation)?.id
	// A finished replay shows the map as it stands now.
	val shown = playing?.takeIf { it.moment < it.replay.length }?.let { runs + (it.id to it.replay.runAt(it.moment)) } ?: runs
	val facts = remember(graph, shown, chosen) { flowFacts(graph, shown, chosen) }
	val newest = remember(graph, runs) { flowFacts(graph, runs) }
	Text(summaryLine(flowSummary(input.rows, newest)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	if (input.rows.isEmpty()) {
		NoneLine("automations")
		return
	}
	val reach = remember(graph, selected) { selected?.let { flowReach(graph, it) } }
	val dot = playing?.let { held -> held.replay.dotAt(held.moment)?.let { (path, through) -> Triple(held.id, path, through) } }
	FlowCanvas(graph, facts, selected, reach, dot) { key ->
		replaying = replaying?.takeIf { key == selected }
		picked = key
	}
	playing?.let { held ->
		LaunchedEffect(held.id, held.playing) {
			if (!held.playing) return@LaunchedEffect
			var last = withFrameMillis { it }
			while (true) {
				val now = withFrameMillis { it }
				val going = replaying?.advanced(now - last) ?: break
				last = now
				replaying = going
				if (!going.playing) break
			}
		}
	}
	selected?.let { key ->
		flowSheet(graph, newest, input.rows, key)?.let { sheet ->
			FlowSheetCard(
				sheet = sheet,
				offer = offer,
				replaying = playing,
				opens = opens,
				onOpen = onOpen,
				onReplay = { id -> input.rows.firstOrNull { it.id == id }?.lastRun?.let { replaying = Replaying.of(id, it) } },
				onPlay = { replaying = replaying?.toggled() },
				onScrub = { moment -> replaying = replaying?.scrubbed(moment) },
				onSelect = { picked = FlowKey.Automation(it) },
			)
		}
	}
}

@Composable
private fun FlowCanvas(
	graph: FlowGraph,
	facts: FlowFactsMap,
	selected: FlowKey?,
	reach: Set<FlowLine>?,
	/** Automation, path, progress. */
	dot: Triple<String, String, Float>?,
	onTap: (FlowKey?) -> Unit,
) {
	val measurer = rememberTextMeasurer()
	val density = LocalDensity.current
	val palette = flowPalette()
	val labelStyle = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp)
	val rowStyle = TextStyle(fontSize = 9.sp, letterSpacing = 0.4.sp, color = palette.faint)
	val saidStyle = TextStyle(fontSize = 9.sp)
	val moving = (facts.lines + facts.nodes.values).any { patternOf(it) == FlowPattern.MOVING_DASH }
	val dash = if (moving) movingDash() else 0f
	BoxWithConstraints(Modifier.fillMaxWidth()) {
		val available = maxWidth.value
		val layout = remember(graph, available) {
			flowLayout(graph, { node ->
				val wraps = roleOf(node.key) == FlowRole.AUTOMATION
				val cap = if (wraps) PILL_LABEL_MAX else MAP_LABEL_MAX
				val measured = measurer.measure(
					node.label,
					labelStyle,
					maxLines = if (wraps) 2 else 1,
					overflow = TextOverflow.Ellipsis,
					constraints = Constraints(maxWidth = with(density) { cap.dp.roundToPx() }),
				)
				with(density) { measured.size.width.toDp().value } + 1f
			}, available)
		}
		var scale by remember(layout.width) { mutableFloatStateOf((available / layout.width).coerceIn(0.75f, 1f)) }
		val reached = reach?.let { lines -> selected?.let { reachedNodes(it, lines) } }
		Canvas(
			Modifier
				.horizontalScroll(rememberScrollState())
				.size((layout.width * scale).dp, (layout.height * scale).dp)
				.pointerInput(layout) {
					awaitEachGesture {
						awaitFirstDown(requireUnconsumed = false)
						do {
							val event = awaitPointerEvent()
							if (event.changes.size >= 2) {
								scale = (scale * event.calculateZoom()).coerceIn(SCALE_MIN, SCALE_MAX)
								event.changes.forEach { it.consume() }
							}
						} while (event.changes.any { it.pressed })
					}
				}
				.pointerInput(layout, scale) {
					detectTapGestures { at ->
						val k = density.density * scale
						onTap(layout.hit(FlowPoint(at.x / k, at.y / k)))
					}
				},
		) {
			val k = density.density * scale
			for (band in layout.rows) {
				val title = when (band.role) {
					FlowRole.START -> "WHEN"
					FlowRole.AUTOMATION -> "AUTOMATION"
					FlowRole.FUNCTION -> if (band.layer == 0) "FUNCTION" else null
					FlowRole.ACTED -> "ACTS ON"
				} ?: continue
				drawText(measurer, title, Offset(FlowSize.PAD * k, (band.centerY - FlowSize.PILL_H / 2 - FlowSize.LABEL_H - FlowSize.ROW_TITLE + 4f) * k), rowStyle.copy(fontSize = rowStyle.fontSize * scale))
			}
			graph.lines.forEachIndexed { index, line ->
				val curve = layout.curves[index]
				val lineFacts = facts.lines[index]
				val dim = reach != null && line !in reach
				drawLine(curve, lineFacts, palette, k, dash, if (dim) 0.25f else 1f)
				lineFacts.said?.let { said ->
					val text = "${said.reason} · ${clockOf(said.at)}"
					val measured = measurer.measure(text, saidStyle.copy(color = palette.of(colourOf(lineFacts)), fontSize = saidStyle.fontSize * scale), maxLines = 1, overflow = TextOverflow.Ellipsis, constraints = Constraints(maxWidth = (MAP_LABEL_MAX * k).toInt()))
					val mid = curve.mid
					val topLeft = Offset(mid.x * k - measured.size.width / 2f, mid.y * k - measured.size.height / 2f)
					drawRect(palette.card.copy(alpha = if (dim) 0.25f else 0.9f), topLeft, Size(measured.size.width.toFloat(), measured.size.height.toFloat()))
					drawText(measured, alpha = if (dim) 0.25f else 1f, topLeft = topLeft)
				}
			}
			dot?.let { (id, path, through) ->
				val at = graph.lines.indexOfFirst { path in it.steps[id].orEmpty() }
				if (at >= 0) {
					val point = layout.curves[at].at(through)
					drawCircle(palette.primary, 4f * k, Offset(point.x * k, point.y * k))
				}
			}
			for (node in graph.nodes) {
				val box = layout.boxes.getValue(node.key)
				val nodeFacts = facts.nodes[node.key] ?: continue
				val alpha = if (reached != null && node.key !in reached) 0.25f else 1f
				drawNode(node, box, nodeFacts, node.key == selected, palette, k, dash, alpha, measurer, labelStyle.copy(fontSize = labelStyle.fontSize * scale))
			}
		}
	}
}

/** Only drawn while something moves. */
@Composable
private fun movingDash(): Float {
	val dash by rememberInfiniteTransition(label = "dash").animateFloat(
		initialValue = 0f,
		targetValue = 28f,
		animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
		label = "dash",
	)
	return dash
}

private fun clockOf(at: Long): String =
	java.time.format.DateTimeFormatter.ofPattern("HH:mm").format(java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneId.systemDefault()))

private fun strokeOf(facts: FlowFacts, width: Float, dash: Float, k: Float): Stroke {
	val effect = when (patternOf(facts)) {
		FlowPattern.SOLID -> null
		FlowPattern.MOVING_DASH -> PathEffect.dashPathEffect(floatArrayOf(8f * k, 6f * k), -dash * k)
		FlowPattern.DOTS -> PathEffect.dashPathEffect(floatArrayOf(0.1f, 7f * k))
	}
	val dotted = patternOf(facts) == FlowPattern.DOTS
	return Stroke(width = if (dotted) 2f * k else width, cap = if (dotted) StrokeCap.Round else StrokeCap.Butt, pathEffect = effect)
}

private fun widthOf(facts: FlowFacts, thin: Float): Float = when (weightOf(facts)) {
	FlowWeight.THIN -> thin
	FlowWeight.THICK -> 3.4f
}

private fun DrawScope.drawLine(curve: FlowCurve, facts: FlowFacts, palette: FlowPalette, k: Float, dash: Float, alpha: Float) {
	val colour = palette.of(colourOf(facts))
	val path = Path().apply {
		moveTo(curve.start.x * k, curve.start.y * k)
		quadraticTo(curve.control.x * k, curve.control.y * k, curve.end.x * k, curve.end.y * k)
	}
	if (weightOf(facts) == FlowWeight.THICK) {
		drawPath(path, colour, alpha = 0.18f * alpha, style = Stroke(width = 10f * k, cap = StrokeCap.Round))
	}
	drawPath(path, colour, alpha = alpha, style = strokeOf(facts, widthOf(facts, 1.3f) * k, dash, k))
	val angle = atan2(curve.end.y - curve.control.y, curve.end.x - curve.control.x)
	val tip = Offset(curve.end.x * k, curve.end.y * k)
	val head = Path().apply {
		moveTo(tip.x, tip.y)
		lineTo(tip.x - 6f * k * cos(angle - 0.45f), tip.y - 6f * k * sin(angle - 0.45f))
		lineTo(tip.x - 6f * k * cos(angle + 0.45f), tip.y - 6f * k * sin(angle + 0.45f))
		close()
	}
	drawPath(head, colour, alpha = alpha, style = Fill)
	if (facts.onFailure) {
		val start = Offset(curve.start.x * k, curve.start.y * k + 5f * k)
		val diamond = Path().apply {
			moveTo(start.x, start.y - 4f * k)
			lineTo(start.x + 4f * k, start.y)
			lineTo(start.x, start.y + 4f * k)
			lineTo(start.x - 4f * k, start.y)
			close()
		}
		drawPath(diamond, colour, alpha = alpha, style = Fill)
	}
}

private fun DrawScope.drawNode(
	node: FlowNode,
	box: FlowBox,
	facts: FlowFacts,
	selected: Boolean,
	palette: FlowPalette,
	k: Float,
	dash: Float,
	alpha: Float,
	measurer: TextMeasurer,
	style: TextStyle,
) {
	val colour = palette.of(colourOf(facts))
	val fill = if (selected) palette.primary else palette.card
	val outline = strokeOf(facts, widthOf(facts, 1.4f) * k, dash, k)
	val center = Offset(box.center.x * k, box.center.y * k)
	val role = roleOf(node.key)
	val textColour = if (selected) palette.onPrimary else palette.label
	when (role) {
		FlowRole.START, FlowRole.ACTED -> {
			val radius = FlowSize.RING / 2 * k
			if (weightOf(facts) == FlowWeight.THICK) drawCircle(colour, radius + 4f * k, center, alpha = 0.18f * alpha)
			drawCircle(fill, radius, center, alpha = alpha)
			drawCircle(colour, radius, center, alpha = alpha, style = outline)
			val label = measurer.measure(node.label, style.copy(color = palette.label), maxLines = 1, overflow = TextOverflow.Ellipsis, constraints = Constraints(maxWidth = (MAP_LABEL_MAX * k).toInt()))
			val y = if (role == FlowRole.START) center.y - radius - 3f * k - label.size.height else center.y + radius + 3f * k
			drawText(label, alpha = alpha, topLeft = Offset(center.x - label.size.width / 2f, y))
		}
		FlowRole.AUTOMATION, FlowRole.FUNCTION -> {
			val size = Size(box.width * k, box.height * k)
			val topLeft = Offset(center.x - size.width / 2, center.y - size.height / 2)
			val corner = if (role == FlowRole.AUTOMATION) CornerRadius(size.height / 2) else CornerRadius(4f * k)
			if (weightOf(facts) == FlowWeight.THICK) {
				drawRoundRect(colour, Offset(topLeft.x - 4f * k, topLeft.y - 4f * k), Size(size.width + 8f * k, size.height + 8f * k), corner, alpha = 0.18f * alpha)
			}
			drawRoundRect(fill, topLeft, size, corner, alpha = alpha)
			drawRoundRect(colour, topLeft, size, corner, alpha = alpha, style = outline)
			val mark = if (role == FlowRole.FUNCTION) "$FUNCTION_MARK " else ""
			val room = ((box.width - FlowSize.PILL_PAD) * k).toInt().coerceAtLeast(1)
			val label = measurer.measure(mark + node.label, style.copy(color = textColour), maxLines = if (role == FlowRole.AUTOMATION) 2 else 1, overflow = TextOverflow.Ellipsis, constraints = Constraints(maxWidth = room + if (mark.isEmpty()) 0 else (FlowSize.MARK * k).toInt()))
			drawText(label, alpha = alpha, topLeft = Offset(center.x - label.size.width / 2f, center.y - label.size.height / 2f))
		}
	}
}

@Composable
private fun FlowSheetCard(
	sheet: FlowSheet,
	offer: AutomationOffer,
	replaying: Replaying?,
	opens: (String) -> Boolean,
	onOpen: (String) -> Unit,
	onReplay: (String) -> Unit,
	onPlay: () -> Unit,
	onScrub: (Long) -> Unit,
	onSelect: (String) -> Unit,
) {
	val palette = flowPalette()
	val dim = MaterialTheme.colorScheme.onSurfaceVariant
	Card(Modifier.fillMaxWidth()) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			when (sheet) {
				is FlowSheet.OfAutomation -> {
					Row(verticalAlignment = Alignment.CenterVertically) {
						Text(sheet.sentence, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
						if (opens(sheet.id)) {
							IconButton(onClick = hapticClick { onOpen(sheet.id) }) { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = "Open") }
						}
					}
					for (note in sheet.notes) Text(noteText(note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
					if (sheet.steps.isEmpty()) Text("Has not run", style = MaterialTheme.typography.bodySmall, color = dim)
					for (step in sheet.steps) {
						Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
							Text(offer.labelOf(step.kind), style = MaterialTheme.typography.bodySmall, color = palette.of(colourOf(FlowFacts(step.ended, FlowHappened.RAN))), modifier = Modifier.weight(1f))
							Text(listOfNotNull(step.reason ?: if (step.open) "running" else endedWord(step.ended), step.tookMs?.let(::tookText)).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = dim)
						}
					}
					if (sheet.replays) ReplayControls(sheet.id, replaying, onReplay, onPlay, onScrub)
				}
				is FlowSheet.OfFunction -> {
					Text("$FUNCTION_MARK ${sheet.name}", style = MaterialTheme.typography.bodyLarge)
					for (note in sheet.notes) Text(noteText(note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
					Text("Run by", style = MaterialTheme.typography.labelMedium, color = dim)
					for (user in sheet.runBy) {
						Row(Modifier.fillMaxWidth().clickable(onClick = hapticClick { onSelect(user.id) }), verticalAlignment = Alignment.CenterVertically) {
							Text(user.sentence, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
							if (opens(user.id)) {
								IconButton(onClick = hapticClick { onOpen(user.id) }) { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = "Open") }
							}
						}
					}
				}
				is FlowSheet.OfThing -> {
					Text(sheet.label, style = MaterialTheme.typography.bodyLarge)
					for (touch in sheet.touches) {
						Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
							Text(touch.label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
							Text(endedWord(touch.ended), style = MaterialTheme.typography.bodySmall, color = palette.of(colourOf(FlowFacts(touch.ended, FlowHappened.RAN))))
						}
					}
				}
			}
		}
	}
}

@Composable
private fun ReplayControls(id: String, replaying: Replaying?, onReplay: (String) -> Unit, onPlay: () -> Unit, onScrub: (Long) -> Unit) {
	val held = replaying?.takeIf { it.id == id }
	if (held == null) {
		TextButton(onClick = hapticClick { onReplay(id) }) { Text("Replay") }
		return
	}
	Row(verticalAlignment = Alignment.CenterVertically) {
		IconButton(onClick = hapticClick(onPlay)) {
			Icon(if (held.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (held.playing) "Pause" else "Play")
		}
		Slider(
			value = held.moment.toFloat(),
			onValueChange = { onScrub(it.toLong()) },
			valueRange = 0f..held.replay.length.toFloat().coerceAtLeast(1f),
			modifier = Modifier.weight(1f),
		)
		Text(tookText(held.replay.realAt(held.moment)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	}
}

@Composable
private fun FlowKeyDialog(onDismiss: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
		title = { Text("Key") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
				for (line in FLOW_KEY) Text(line, style = MaterialTheme.typography.bodySmall)
			}
		},
	)
}

private val FLOW_KEY = listOf(
	"A ring is what starts a run (above) or what a run acts on (below). A round pill is an automation; a square box with ${FUNCTION_MARK} is a named function.",
	"Down is cause: what starts it, the automation, its functions, what they act on.",
	"Grey ran as written. Amber was not clean: held up, retried or no answer. Red did not get done. Faint has nothing to show.",
	"Solid happened in its last run. Moving dashes are happening now. Dots did not happen: switched off, or never reached.",
	"Thick with a glow is where a failure nothing caught began.",
	"A diamond at a line's start runs only when something failed.",
	"Tap to select: the rest dims, and the sheet says more.",
)
