package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.proto.DeviceCapability
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.INTEGRATIONS
import com.atelier_nyaarium.switchboard.proto.Integration
import com.atelier_nyaarium.switchboard.proto.IntegrationAct
import com.atelier_nyaarium.switchboard.proto.IntegrationGroup
import com.atelier_nyaarium.switchboard.proto.IntegrationYield
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.routines.grantedLine
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.grantableOn

/** The compiled catalogue's entry, or null for an id this build does not know. */
internal fun catalogued(id: String): Integration? = INTEGRATIONS.find { it.id == id }

/** What this Gateway serves, in catalogue order; an older Gateway offers nothing to add. */
internal fun offeredEntries(offered: List<String>?): List<Integration> =
	if (offered == null) emptyList() else INTEGRATIONS.filter { it.id in offered }

internal data class AddGroup(val group: IntegrationGroup, val entries: List<Integration>)

/** Add page: groups in declared order, empty ones dropped, filtered by the search text. */
internal fun addGroups(offered: List<String>?, query: String): List<AddGroup> {
	val wanted = query.trim()
	val matching = offeredEntries(offered).filter { entry ->
		wanted.isEmpty() || entry.label.contains(wanted, ignoreCase = true)
	}
	return IntegrationGroup.entries.mapNotNull { group ->
		matching.filter { it.group == group }.takeIf { it.isNotEmpty() }?.let { AddGroup(group, it) }
	}
}

internal fun groupTitle(group: IntegrationGroup): String = when (group) {
	IntegrationGroup.PROTOCOL -> "Protocols"
	IntegrationGroup.SERVICE -> "Services"
	IntegrationGroup.BRAND -> "Brands"
}

/** A service is added once it holds a grant. */
internal fun serviceAdded(service: AssistantIntegration): Boolean = service.grants.isNotEmpty()

internal data class ServiceRow(val id: String, val label: String, val grants: List<String>, val grantedLine: String)

/** Added services, labelled by the catalogue where it knows the id. */
internal fun serviceRows(services: List<AssistantIntegration>?, entries: List<VaultEntryView>): List<ServiceRow> =
	services.orEmpty().filter(::serviceAdded).map { service ->
		ServiceRow(service.id, catalogued(service.id)?.label ?: service.label, service.grants, grantedLine(service.grants, entries))
	}

internal data class ServiceEntry(
	val integration: Integration,
	val grants: List<String>,
	val grantedLine: String,
	val offered: List<VaultEntryView>,
)

/** Only an answer holds grants. */
internal fun serviceEntryOf(
	read: AssistantRead,
	integration: Integration,
	entries: List<VaultEntryView>,
	gatewayId: String,
): ServiceEntry? = when (read) {
	is AssistantRead.Answered -> serviceEntry(integration, read.state.integrations, entries, gatewayId)
	AssistantRead.Reading, AssistantRead.Refused -> null
}

/** An older Gateway holds no services. */
private fun serviceEntry(
	integration: Integration,
	services: List<AssistantIntegration>?,
	entries: List<VaultEntryView>,
	gatewayId: String,
): ServiceEntry? {
	if (integration.yields != IntegrationYield.ACTIONS) return null
	val grants = services.orEmpty().find { it.id == integration.id }?.grants.orEmpty()
	return ServiceEntry(integration, grants, grantedLine(grants, entries), entries.grantableOn(gatewayId))
}

internal fun brandLine(record: DeviceRecord): String = catalogued(record.driver)?.label ?: record.driver

/** An unknown brand still switches. */
internal fun capabilitiesOf(record: DeviceRecord): List<DeviceCapability> =
	catalogued(record.driver)?.capabilities ?: listOf(DeviceCapability.SWITCH)

internal fun providerActs(record: DeviceRecord): List<IntegrationAct> = catalogued(record.driver)?.acts.orEmpty()

internal const val ACT_CLOUD_DISCONNECT = "cloud_disconnect"

/** Whether the settings read leave the act meaningful. */
internal fun actOffered(key: String, settings: DeviceSettings?): Boolean = when (key) {
	ACT_CLOUD_DISCONNECT -> (settings as? DeviceSettings.Kasa)?.cloud == Protocol.Wire.DeviceCloudState.BOUND
	else -> false
}

/** Under the brand only while the switch cannot say the state. */
internal fun troubleLine(live: DeviceLive?): String? =
	if (live != null && live.confirmed && !live.stale) null else liveLine(live)

