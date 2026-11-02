package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.grantableOn

internal data class AssistantIntegrationRow(
	val integration: AssistantIntegration,
	val grantedLine: String,
	val offered: List<VaultEntryView>,
)

internal fun integrationRows(
	integrations: List<AssistantIntegration>?,
	entries: List<VaultEntryView>,
	gatewayId: String?,
): List<AssistantIntegrationRow> {
	if (gatewayId == null) return emptyList()
	val offered = entries.grantableOn(gatewayId)
	return integrations.orEmpty().map { integration ->
		AssistantIntegrationRow(integration, grantedLine(integration.grants, entries), offered)
	}
}

internal fun integrationRowForGrant(
	rows: List<AssistantIntegrationRow>,
	granting: String?,
): AssistantIntegrationRow? = rows.firstOrNull { it.integration.id == granting }
