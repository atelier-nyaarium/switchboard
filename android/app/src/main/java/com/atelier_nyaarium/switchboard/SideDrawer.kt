package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.AnchoredDraggableState
import androidx.compose.foundation.gestures.DraggableAnchors
import androidx.compose.foundation.gestures.animateTo
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Policy
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.DrawerDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/** Opens from either edge. */
@Stable
internal class SideDrawers {
	internal val state = AnchoredDraggableState(DrawerSlot.CLOSED)

	suspend fun open(side: DrawerSide) = state.animateTo(slotOf(side))

	suspend fun close() = state.animateTo(DrawerSlot.CLOSED)

	/** Open or closing, so Back belongs to the drawer. */
	fun holdsBack(): Boolean = state.currentValue != DrawerSlot.CLOSED || state.targetValue != DrawerSlot.CLOSED
}

// Nested Material drawers swallow each other's swipe.
@Composable
internal fun SideDrawer(
	drawers: SideDrawers,
	sheet: @Composable ColumnScope.() -> Unit,
	content: @Composable () -> Unit,
) {
	val state = drawers.state
	val width = with(LocalDensity.current) { DRAWER_WIDTH.toPx() }
	val settled = state.settledValue
	val anchors = remember(settled, width) {
		DraggableAnchors { drawerAnchors(settled, width).forEach { (slot, at) -> slot at at } }
	}
	// Before the first frame, so an early open has anchors.
	SideEffect { if (state.anchors !== anchors) state.updateAnchors(anchors) }
	val offset = { state.offset.takeUnless { it.isNaN() } ?: 0f }
	val shown by remember(state) { derivedStateOf { slotShown(offset()) } }
	val scope = rememberCoroutineScope()

	BoxWithConstraints(Modifier.fillMaxSize().pointerInput(state, width) { swipeDrawer(state, width, scope) }) {
		val screen = constraints.maxWidth
		content()
		if (shown != DrawerSlot.CLOSED) {
			Box(
				Modifier
					.fillMaxSize()
					.graphicsLayer { alpha = (abs(offset()) / width).coerceIn(0f, 1f) }
					.background(DrawerDefaults.scrimColor)
					.pointerInput(drawers) { detectTapGestures { scope.launch { drawers.close() } } }
					.semantics {
						contentDescription = "Close drawer"
						onClick { scope.launch { drawers.close() }; true }
					},
			)
			val outer = LocalLayoutDirection.current
			// Material rounds the end edge.
			val sheetDirection = if (shown == DrawerSlot.RIGHT) LayoutDirection.Rtl else LayoutDirection.Ltr
			CompositionLocalProvider(LocalLayoutDirection provides sheetDirection) {
				ModalDrawerSheet(
					Modifier
						.width(DRAWER_WIDTH)
						.absoluteOffset { IntOffset(sheetX(shown, offset(), width, screen).roundToInt(), 0) }
						.semantics { paneTitle = "Navigation menu" },
				) {
					CompositionLocalProvider(LocalLayoutDirection provides outer) {
						Column(Modifier.fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
							sheet()
						}
					}
				}
			}
		}
	}
}

/** Claims only a near-horizontal swipe, then follows the finger. */
private suspend fun PointerInputScope.swipeDrawer(
	state: AnchoredDraggableState<DrawerSlot>,
	width: Float,
	scope: CoroutineScope,
) {
	val fling = DRAWER_FLING_VELOCITY.toPx()
	awaitEachGesture {
		val down = awaitFirstDown(requireUnconsumed = false)
		val slop = viewConfiguration.touchSlop * SWIPE_SLOP_SCALE
		var travel = Offset.Zero
		var claimed: Boolean? = null
		while (claimed == null) {
			val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
			if (!change.pressed || change.isConsumed) return@awaitEachGesture
			travel += change.positionChange()
			claimed = swipeClaim(travel.x, travel.y, slop)
		}
		if (!claimed) return@awaitEachGesture

		val tracker = VelocityTracker().apply { addPosition(down.uptimeMillis, down.position) }
		val deltas = Channel<Float>(Channel.UNLIMITED)
		val drag = scope.launch {
			state.anchoredDrag(MutatePriority.UserInput) { anchors ->
				for (delta in deltas) {
					dragTo((state.offset + delta).coerceIn(anchors.minPosition(), anchors.maxPosition()))
				}
			}
		}
		deltas.trySend(travel.x)
		var velocity = 0f
		try {
			while (true) {
				val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
				if (!change.pressed) break
				tracker.addPosition(change.uptimeMillis, change.position)
				deltas.trySend(change.positionChange().x)
				change.consume()
			}
			velocity = tracker.calculateVelocity().x
		} finally {
			// A cancelled gesture must still release the drag.
			deltas.close()
			scope.launch {
				drag.join()
				state.animateTo(releasedSlot(state.offset, velocity, width, fling))
			}
		}
	}
}

@Composable
internal fun DrawerButton(badged: Boolean, onClick: () -> Unit) {
	IconButton(onClick = hapticClick(onClick)) {
		BadgedBox(badge = { if (badged) Badge() }) {
			Icon(Icons.Default.Menu, contentDescription = "Open drawer")
		}
	}
}

@Composable
internal fun DrawerHeader(title: String, subtitle: String?, monospace: Boolean = false) {
	Column(Modifier.padding(horizontal = 28.dp, vertical = 12.dp)) {
		Text(
			title,
			style = MaterialTheme.typography.titleMedium,
			fontFamily = if (monospace) FontFamily.Monospace else null,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis,
		)
		subtitle?.let {
			Text(
				it,
				style = MaterialTheme.typography.labelMedium,
				fontFamily = FontFamily.Monospace,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 1,
				overflow = TextOverflow.Ellipsis,
			)
		}
	}
}

@Composable
internal fun DrawerRow(title: String, icon: ImageVector, selected: Boolean, mark: DrawerMark?, onClick: () -> Unit) {
	NavigationDrawerItem(
		label = { Text(title) },
		icon = { Icon(icon, contentDescription = null) },
		selected = selected,
		onClick = hapticClick(onClick),
		badge = when (mark) {
			is DrawerMark.Detail -> {
				{ Text(mark.text, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace) }
			}
			is DrawerMark.Badge -> {
				{ Badge { Text("${mark.count}") } }
			}
			null -> null
		},
		modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
	)
}

@Composable
internal fun DrawerDivider() {
	HorizontalDivider(Modifier.padding(horizontal = 28.dp, vertical = 8.dp))
}

internal fun iconOf(view: RootView): ImageVector = view.scoped?.let(::iconOf) ?: Icons.Default.Forum

internal fun iconOf(view: ConversationView): ImageVector = view.scoped?.let(::iconOf) ?: when (view) {
	ConversationView.TERMINAL -> Icons.Default.Terminal
	ConversationView.FILES -> Icons.Default.Folder
	else -> Icons.AutoMirrored.Filled.Chat
}

private fun iconOf(view: ScopedView): ImageVector = when (view) {
	ScopedView.BACKLOG -> Icons.Default.Checklist
	ScopedView.RUNBOOKS -> Icons.AutoMirrored.Filled.MenuBook
	ScopedView.ROUTINES -> Icons.Default.Schedule
	ScopedView.POLICIES -> Icons.Default.Policy
	ScopedView.VAULT -> Icons.Default.Key
}

private val DRAWER_WIDTH = 304.dp

// Material's drawer threshold.
private val DRAWER_FLING_VELOCITY = 400.dp

private const val SWIPE_SLOP_SCALE = 2f
