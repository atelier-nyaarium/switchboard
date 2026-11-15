package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.DeviceListView
import com.atelier_nyaarium.switchboard.integrationCountLine
import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.sourceTroubled

internal data class SettingsLines(val warning: String? = null, val line: String? = null)

internal const val NOT_PLACED = "Not placed"

internal const val SOURCE_NEEDS_CONFIGURATION = "A source needs configuration"

internal const val REMOVE_LINE = "Permanently removes Switchboard Assistant for your Domain."

internal fun locationLines(home: String?, workdir: String?): SettingsLines =
	if (home == null) SettingsLines(warning = NOT_PLACED) else SettingsLines(line = listOfNotNull(home, workdir).joinToString(" · "))

internal fun featureLines(assistantRole: Boolean, screenData: Boolean, views: List<FeatureView>): SettingsLines =
	SettingsLines(warning = lostLine(views), line = enabledLine(assistantRole, screenData, views))

internal fun safetyLines(approveEverySend: Boolean?): SettingsLines =
	SettingsLines(line = approveEverySend?.let { "Approve every send: ${if (it) "on" else "off"}" })

internal const val PLACE_FIRST = "Place the assistant first"

/** Counts per type; a list that cannot be read is the warning. */
internal fun integrationLines(home: String?, devices: DeviceListView?, services: List<AssistantIntegration>?): SettingsLines = when {
	home == null -> SettingsLines(line = PLACE_FIRST)
	devices is DeviceListView.Listed -> SettingsLines(line = integrationCountLine(devices.records, services))
	devices is DeviceListView.Unavailable -> SettingsLines(warning = devices.line)
	devices == DeviceListView.Declined -> SettingsLines(line = integrationCountLine(emptyList(), services))
	else -> SettingsLines()
}

/** A troubled service first, then counts per type. */
internal fun sourceLines(
	home: String?,
	devices: DeviceListView?,
	services: List<AssistantIntegration>?,
	sources: List<AssistantSource>,
): SettingsLines {
	val counted = integrationLines(home, devices, services)
	val troubled = sources.any { it.enabled && sourceTroubled(it) }
	return if (troubled) counted.copy(warning = counted.warning ?: SOURCE_NEEDS_CONFIGURATION) else counted
}

internal fun automationLines(count: Int): SettingsLines = SettingsLines(line = automationCountLine(count))
