package com.atelier_nyaarium.switchboard

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
internal fun SideDrawer(
	side: DrawerSide,
	state: DrawerState,
	sheet: @Composable ColumnScope.() -> Unit,
	content: @Composable () -> Unit,
) {
	val outer = LocalLayoutDirection.current
	val scope = rememberCoroutineScope()
	// Composed on open and held through closing, so it outranks the screen's Back.
	if (state.targetValue == DrawerValue.Open || state.currentValue == DrawerValue.Open) {
		BackHandler { scope.launch { state.close() } }
	}
	// Material uses the start edge.
	val drawerDirection = if (side == DrawerSide.RIGHT) LayoutDirection.Rtl else LayoutDirection.Ltr
	CompositionLocalProvider(LocalLayoutDirection provides drawerDirection) {
		ModalNavigationDrawer(
			drawerState = state,
			drawerContent = {
				ModalDrawerSheet(drawerState = state, modifier = Modifier.width(DRAWER_WIDTH)) {
					CompositionLocalProvider(LocalLayoutDirection provides outer) {
						Column(Modifier.fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
							sheet()
						}
					}
				}
			},
			content = { CompositionLocalProvider(LocalLayoutDirection provides outer) { content() } },
		)
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
