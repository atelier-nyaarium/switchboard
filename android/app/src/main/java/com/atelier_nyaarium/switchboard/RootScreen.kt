package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RootScreen(
	shown: RootView,
	drawerSide: DrawerSide,
	drawers: SideDrawers,
	sheet: @Composable ColumnScope.() -> Unit,
	drawerBadged: Boolean,
	onOpenDrawer: () -> Unit,
	/** A pick over a session returns to it. */
	onBack: (() -> Unit)?,
	onRefresh: () -> Unit,
	onAssistantSettings: (() -> Unit)?,
	// Idle has no action.
	queueState: QueueGlance,
	onQueue: () -> Unit,
	viewActions: @Composable RowScope.(RootView) -> Unit,
	body: @Composable (RootView, Modifier) -> Unit,
) {
	SideDrawer(drawers = drawers, sheet = sheet) {
		Scaffold(
			topBar = {
				TopAppBar(
					title = { Text(shown.title) },
					navigationIcon = {
						Row {
							if (onBack != null) {
								IconButton(onClick = hapticClick(onBack)) {
									Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to session")
								}
							}
							if (drawerSide == DrawerSide.LEFT) DrawerButton(drawerBadged, onOpenDrawer)
						}
					},
					actions = {
						viewActions(shown)
						// The queue's only in-app door.
						if (queueState != QueueGlance.IDLE) {
							IconButton(onClick = hapticClick(onQueue)) {
								Icon(
									when (queueState) {
										QueueGlance.ALERT -> Icons.Filled.Warning
										QueueGlance.PAUSED -> Icons.Filled.Pause
										else -> Icons.Default.PlayArrow
									},
									contentDescription = when (queueState) {
										QueueGlance.ALERT -> "Messages not spoken"
										QueueGlance.PAUSED -> "Speaking queue, paused"
										else -> "Speaking queue"
									},
								)
							}
						}
						if (shown == RootView.ASSISTANT && onAssistantSettings != null) {
							IconButton(onClick = hapticClick(onAssistantSettings)) {
								Icon(Icons.Default.Settings, contentDescription = "Assistant settings")
							}
						}
						IconButton(onClick = hapticClick(onRefresh)) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
						if (drawerSide == DrawerSide.RIGHT) DrawerButton(drawerBadged, onOpenDrawer)
					},
				)
			},
		) { pad ->
			Box(Modifier.padding(pad).fillMaxSize()) { body(shown, Modifier.fillMaxSize()) }
		}
	}
}
