package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RootScreen(
	views: List<RootView>,
	shown: RootView,
	onView: (RootView) -> Unit,
	drawerSide: DrawerSide,
	drawerState: DrawerState,
	domainId: String?,
	vaultPending: Int,
	snackbarHostState: SnackbarHostState,
	onRefresh: () -> Unit,
	onSettings: () -> Unit,
	// Idle has no action.
	queueState: QueueGlance,
	onQueue: () -> Unit,
	body: @Composable (RootView, Modifier) -> Unit,
) {
	val scope = rememberCoroutineScope()
	val marks = views.map { rootMark(it, vaultPending) }

	SideDrawer(
		side = drawerSide,
		state = drawerState,
		sheet = {
			DrawerHeader("Switchboard", domainId)
			views.forEachIndexed { index, view ->
				DrawerRow(view.title, iconOf(view), view == shown, marks[index]) {
					onView(view)
					scope.launch { drawerState.close() }
				}
			}
			DrawerDivider()
			DrawerRow("Settings", Icons.Default.Settings, selected = false, mark = null) {
				scope.launch { drawerState.close() }
				onSettings()
			}
		},
	) {
		Scaffold(
			topBar = {
				TopAppBar(
					title = { Text(shown.title) },
					navigationIcon = {
						if (drawerSide == DrawerSide.LEFT) DrawerButton(anyBadge(marks)) { scope.launch { drawerState.open() } }
					},
					actions = {
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
						IconButton(onClick = hapticClick(onRefresh)) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
						if (drawerSide == DrawerSide.RIGHT) DrawerButton(anyBadge(marks)) { scope.launch { drawerState.open() } }
					},
				)
			},
			snackbarHost = { SnackbarHost(snackbarHostState) },
		) { pad ->
			Box(Modifier.padding(pad).fillMaxSize()) { body(shown, Modifier.fillMaxSize()) }
		}
	}
}
