package com.atelier_nyaarium.switchboard.assistant

internal data class SettingsLines(val warning: String? = null, val line: String? = null)

internal const val NOT_PLACED = "Not placed"

internal const val REMOVE_LINE = "Permanently removes Switchboard Assistant for your Domain."

internal fun locationLines(home: String?, workdir: String?): SettingsLines =
	if (home == null) SettingsLines(warning = NOT_PLACED) else SettingsLines(line = listOfNotNull(home, workdir).joinToString(" · "))

internal fun featureLines(assistantRole: Boolean, screenData: Boolean, views: List<FeatureView>): SettingsLines =
	SettingsLines(warning = lostLine(views), line = enabledLine(assistantRole, screenData, views))

internal fun safetyLines(approveEverySend: Boolean?): SettingsLines =
	SettingsLines(line = approveEverySend?.let { "Approve every send: ${if (it) "on" else "off"}" })

internal const val PLACE_FIRST = "Place the assistant first"
