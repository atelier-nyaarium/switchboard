package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Protocol

/** Same spawn and session everywhere. */
internal const val ASSISTANT_SPAWN = "host"
private const val ASSISTANT_SESSION = "assistant"

/** What the Assistant root shows. */
internal sealed interface AssistantRoot {
	data class Placed(val team: String) : AssistantRoot

	/** Nothing read yet: nothing drawn. */
	data object Loading : AssistantRoot

	data object RouterUnreachable : AssistantRoot

	/** Nobody, or never written. */
	data object SetUp : AssistantRoot

	/** Chosen; its Gateway has not reported. */
	data class Moving(val gatewayId: String) : AssistantRoot

	data class Failed(val reason: String) : AssistantRoot

	data class HomeUnreachable(val gatewayId: String) : AssistantRoot
}

/** The Gateway a read record names. */
internal fun assistantGateway(state: ChatState): String? = (state.assistantHome as? AssistantHome.Read)?.record?.gatewayId

/** Moves on a new choice or report. */
internal fun homeVersions(state: ChatState): Pair<Long?, Long?> =
	(state.assistantHome as? AssistantHome.Read).let { it?.record?.version to it?.report?.version }

/** The chosen home's address. */
internal fun assistantAddress(state: ChatState): String? = addressOn(state, assistantGateway(state))

/** Its Gateway once reported placed. */
internal fun placedGateway(state: ChatState): String? = currentReport(state)?.takeIf { it.outcome == HOME_PLACED }?.gatewayId

internal fun placedAddress(state: ChatState): String? = addressOn(state, placedGateway(state))

private fun addressOn(state: ChatState, gatewayId: String?): String? {
	val domainId = state.domainId ?: return null
	val at = gatewayId ?: return null
	return runIsolated { Address.of(domainId, at, ASSISTANT_SPAWN, ASSISTANT_SESSION).canonical }.getOrNull()
}

/** The report for the held choice. */
private fun currentReport(state: ChatState): AssistantHomeReport? {
	val held = state.assistantHome as? AssistantHome.Read ?: return null
	val record = held.record ?: return null
	return held.report?.takeIf { it.version == record.version && it.gatewayId == record.gatewayId }
}

private const val HOME_PLACED = "placed"

/** A role stamp, a persisted role, or where it lives now; never the name. */
internal fun isAssistant(state: ChatState, team: String): Boolean =
	(state.teams.firstOrNull { it.name == team }?.role ?: state.roles[team]) == ASSISTANT_ROLE || assistantAddress(state) == team

/** Known past addresses and the current one. */
internal fun assistantTeams(state: ChatState): Set<String> =
	state.teams.filter { it.role == ASSISTANT_ROLE }.map { it.name }.toSet() +
		state.roles.filterValues { it == ASSISTANT_ROLE }.keys +
		listOfNotNull(assistantAddress(state))

/** The one landing state. */
internal fun assistantRoot(state: ChatState): AssistantRoot {
	state.homeFailure?.let { return AssistantRoot.Failed(it) }
	if (routerUnreachable(state)) return AssistantRoot.RouterUnreachable
	val held = state.assistantHome as? AssistantHome.Read ?: return AssistantRoot.Loading
	val record = held.record
	val gatewayId = record?.gatewayId ?: return AssistantRoot.SetUp
	homeRefusal(state)?.let { return AssistantRoot.Failed(it) }
	val registry = state.gateways
	if (registry.current && !registry.reachable(gatewayId)) return AssistantRoot.HomeUnreachable(gatewayId)
	return placedAddress(state)?.let { AssistantRoot.Placed(it) } ?: AssistantRoot.Moving(gatewayId)
}

/** Why a view of the home's records has no home to draw. */
internal enum class NoHome { READING, ROUTER_UNREACHABLE, NOT_PLACED }

internal fun noHome(state: ChatState): NoHome = when (assistantRoot(state)) {
	AssistantRoot.Loading -> NoHome.READING
	AssistantRoot.RouterUnreachable -> NoHome.ROUTER_UNREACHABLE
	else -> NoHome.NOT_PLACED
}

/** The top bar's way out of a stuck landing. */
internal fun rootOffersSettings(root: AssistantRoot): Boolean = root != AssistantRoot.Loading && root != AssistantRoot.RouterUnreachable

/** Why the current choice was refused. */
internal fun homeRefusal(state: ChatState): String? =
	currentReport(state)?.takeIf { it.outcome == Protocol.Wire.SocketFrame.REFUSED }?.let { it.reason ?: "the Gateway turned it down" }

/** Unread or unwritten; a seed may still find a holder. */
internal fun homeUnsettled(state: ChatState): Boolean = (state.assistantHome as? AssistantHome.Read)?.record == null

/** A read record names elsewhere or nobody. */
internal fun assistantLeft(state: ChatState, gatewayId: String): Boolean =
	state.assistantHome is AssistantHome.Read && assistantGateway(state) != gatewayId

/** A page over the shell. */
internal sealed interface ShellPage {
	data object Settings : ShellPage

	data object Location : ShellPage

	data object Features : ShellPage

	data object Safety : ShellPage

	/** The catalogue. */
	data object Add : ShellPage

	/** One catalogue entry on one Gateway. */
	data class Entry(val gatewayId: String, val integrationId: String) : ShellPage

	/** A fresh device's setup, run by the phone. */
	data class Setup(val gatewayId: String, val integrationId: String) : ShellPage

	data class Device(val gatewayId: String, val deviceId: String) : ShellPage

	data class Source(val gatewayId: String, val sourceId: String) : ShellPage

	/** The automations one source triggers. */
	data class SourceAutomations(val gatewayId: String, val sourceId: String) : ShellPage
}

/** The assistant's own pages, not a Sources or Automations child. */
internal val ShellPage.own: Boolean
	get() = this == ShellPage.Settings || this == ShellPage.Location || this == ShellPage.Features ||
		this == ShellPage.Safety

/** Only answers unwind pages. Null closes it. */
internal fun ShellPage.resolved(state: ChatState, devices: (String) -> DeviceListView? = { null }): ShellPage? = when (this) {
	ShellPage.Settings, ShellPage.Location, ShellPage.Features, ShellPage.Safety, ShellPage.Add -> this
	is ShellPage.Entry -> when {
		assistantLeft(state, gatewayId) -> null
		catalogued(integrationId) == null -> ShellPage.Add
		!offers(state.gateways.assistantRead(gatewayId), integrationId) -> ShellPage.Add
		else -> this
	}
	is ShellPage.Setup -> when {
		assistantLeft(state, gatewayId) -> null
		catalogued(integrationId)?.setup == null -> ShellPage.Add
		else -> this
	}
	is ShellPage.Device -> takeUnless { deviceGone(state, devices(gatewayId)) }
	is ShellPage.Source -> takeUnless { sourceGone(state, gatewayId, sourceId) }
	is ShellPage.SourceAutomations -> takeUnless { sourceGone(state, gatewayId, sourceId) }
}

/** Older Gateways name no offer. */
private fun offers(read: AssistantRead, integrationId: String): Boolean = when (read) {
	is AssistantRead.Answered -> read.state.offered?.let { integrationId in it } ?: true
	AssistantRead.Reading, AssistantRead.Refused -> true
}

private fun sourceGone(state: ChatState, gatewayId: String, sourceId: String): Boolean {
	if (assistantLeft(state, gatewayId)) return true
	return when (val read = state.gateways.assistantRead(gatewayId)) {
		is AssistantRead.Answered -> read.state.sources.none { it.id == sourceId }
		AssistantRead.Reading, AssistantRead.Refused -> false
	}
}

/** Null spins or retries. */
internal fun heldSource(read: AssistantRead, sourceId: String): AssistantSource? = when (read) {
	is AssistantRead.Answered -> read.state.sources.find { it.id == sourceId }
	AssistantRead.Reading, AssistantRead.Refused -> null
}

/** Home moves keep it. */
private fun ShellPage.Device.deviceGone(state: ChatState, list: DeviceListView?): Boolean =
	(state.gateways.current && !state.gateways.has(gatewayId)) ||
		(list is DeviceListView.Listed && list.records.none { it.id == deviceId })

internal fun pageWords(page: ShellPage): List<String> = when (page) {
	ShellPage.Settings -> listOf(PAGE_SETTINGS)
	ShellPage.Location -> listOf(PAGE_LOCATION)
	ShellPage.Features -> listOf(PAGE_FEATURES)
	ShellPage.Safety -> listOf(PAGE_SAFETY)
	ShellPage.Add -> listOf(PAGE_ADD)
	is ShellPage.Entry -> listOf(PAGE_ENTRY, page.gatewayId, page.integrationId)
	is ShellPage.Setup -> listOf(PAGE_SETUP, page.gatewayId, page.integrationId)
	is ShellPage.Device -> listOf(PAGE_DEVICE, page.gatewayId, page.deviceId)
	is ShellPage.Source -> listOf(PAGE_SOURCE, page.gatewayId, page.sourceId)
	is ShellPage.SourceAutomations -> listOf(PAGE_SOURCE_AUTOMATIONS, page.gatewayId, page.sourceId)
}

internal fun pageOf(words: List<String>): ShellPage? {
	val gatewayId = words.getOrNull(1)
	val named = words.getOrNull(2)
	return when (words.firstOrNull()) {
		PAGE_SETTINGS -> ShellPage.Settings
		PAGE_LOCATION -> ShellPage.Location
		PAGE_FEATURES -> ShellPage.Features
		PAGE_SAFETY -> ShellPage.Safety
		PAGE_ADD -> ShellPage.Add
		PAGE_ENTRY -> if (gatewayId != null && named != null) ShellPage.Entry(gatewayId, named) else null
		PAGE_SETUP -> if (gatewayId != null && named != null) ShellPage.Setup(gatewayId, named) else null
		PAGE_DEVICE -> if (gatewayId != null && named != null) ShellPage.Device(gatewayId, named) else null
		PAGE_SOURCE -> if (gatewayId != null && named != null) ShellPage.Source(gatewayId, named) else null
		PAGE_SOURCE_AUTOMATIONS -> if (gatewayId != null && named != null) ShellPage.SourceAutomations(gatewayId, named) else null
		else -> null
	}
}

/** Page keys stay unique. */
internal fun pageKey(page: ShellPage): String = pageWords(page).joinToString(Char(0x1e).toString())

private const val PAGE_SETTINGS = "settings"
private const val PAGE_LOCATION = "location"
private const val PAGE_FEATURES = "features"
private const val PAGE_SAFETY = "safety"
private const val PAGE_ADD = "add"
private const val PAGE_ENTRY = "entry"
private const val PAGE_SETUP = "setup"
private const val PAGE_DEVICE = "device"
private const val PAGE_SOURCE = "source"
private const val PAGE_SOURCE_AUTOMATIONS = "source-automations"

/** A thread found to be the assistant's leaves the tabs. */
internal fun ChatState.withoutAssistantTabs(): ChatState {
	val kept = openTabs.filterNot { isAssistant(this, it) }
	return if (kept.size == openTabs.size) this else copy(openTabs = kept)
}
