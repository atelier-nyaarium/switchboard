package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.watcherOn
import com.atelier_nyaarium.switchboard.watcherTroubled

internal data class SettingsLines(val warning: String? = null, val line: String? = null)

internal const val NOT_PLACED = "Not placed"

internal const val WATCHER_NEEDS_CONFIGURATION = "Watcher needs configuration"

internal const val REMOVE_LINE = "Permanently removes Switchboard Assistant for your Domain."

internal fun locationLines(home: String?, workdir: String?): SettingsLines =
	if (home == null) SettingsLines(warning = NOT_PLACED) else SettingsLines(line = listOfNotNull(home, workdir).joinToString(" · "))

internal fun featureLines(assistantRole: Boolean, screenData: Boolean, views: List<FeatureView>): SettingsLines =
	SettingsLines(warning = lostLine(views), line = enabledLine(assistantRole, screenData, views))

internal fun safetyLines(approveEverySend: Boolean?): SettingsLines =
	SettingsLines(line = approveEverySend?.let { "Approve every send: ${if (it) "on" else "off"}" })

internal fun watcherLines(watchers: List<AssistantWatcher>): SettingsLines {
	val on = watchers.filter(::watcherOn)
	return SettingsLines(
		warning = WATCHER_NEEDS_CONFIGURATION.takeIf { on.any(::watcherTroubled) },
		line = "Enabled: ${on.map { it.label }.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "none"}",
	)
}
