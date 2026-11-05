package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/** The system's light or dark, for every surface the app draws: the activity, the panel and overlays. */
@Composable
fun SwitchboardTheme(content: @Composable () -> Unit) {
	val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
	MaterialTheme(colorScheme = colors, content = content)
}
