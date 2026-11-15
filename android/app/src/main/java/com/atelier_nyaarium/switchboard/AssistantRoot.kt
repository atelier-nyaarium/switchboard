package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
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

/** Placed entry preserves pages. */
internal fun ShellNav.enterAssistant(root: AssistantRoot, facts: (String) -> ArrivalFacts): ShellNav {
	if (this.root != RootView.ASSISTANT || conversation != null || settings != null) return this
	val placed = root as? AssistantRoot.Placed ?: return this
	return arriveAt(placed.team, assistant = true, Arrival.OUTSIDE, facts(placed.team)).copy(assistantPage = assistantPage)
}

/** Pages overlay the shell. */
internal sealed interface AssistantPage {
	data object Settings : AssistantPage

	data object Location : AssistantPage

	data object Features : AssistantPage

	data object Safety : AssistantPage

	data object Sources : AssistantPage

	data object Automations : AssistantPage

	/** The catalogue. */
	data object Add : AssistantPage

	/** One catalogue entry on one Gateway. */
	data class Entry(val gatewayId: String, val integrationId: String) : AssistantPage

	/** A fresh device's setup, run by the phone. */
	data class Setup(val gatewayId: String, val integrationId: String) : AssistantPage

	data class Device(val gatewayId: String, val deviceId: String) : AssistantPage

	data class Source(val gatewayId: String, val sourceId: String) : AssistantPage

	data class AutomationEditor(val gatewayId: String, val slot: AutomationSlot) : AssistantPage
}

internal fun assistantPageBack(page: AssistantPage): AssistantPage? = when (page) {
	AssistantPage.Settings -> null
	AssistantPage.Location, AssistantPage.Features, AssistantPage.Safety, AssistantPage.Sources, AssistantPage.Automations ->
		AssistantPage.Settings
	AssistantPage.Add -> AssistantPage.Sources
	is AssistantPage.Entry -> AssistantPage.Add
	is AssistantPage.Setup -> AssistantPage.Entry(page.gatewayId, page.integrationId)
	is AssistantPage.Device -> AssistantPage.Sources
	is AssistantPage.Source -> AssistantPage.Sources
	is AssistantPage.AutomationEditor -> AssistantPage.Automations
}

/** Only answers unwind pages. */
internal fun AssistantPage.resolved(state: ChatState, devices: (String) -> DeviceListView? = { null }): AssistantPage = when (this) {
	AssistantPage.Settings, AssistantPage.Location, AssistantPage.Features, AssistantPage.Safety, AssistantPage.Sources,
	AssistantPage.Automations, AssistantPage.Add -> this
	is AssistantPage.Entry -> when {
		assistantLeft(state, gatewayId) -> AssistantPage.Sources
		catalogued(integrationId) == null -> AssistantPage.Add
		state.gateways.assistantOn(gatewayId)?.offered?.let { integrationId !in it } == true -> AssistantPage.Add
		else -> this
	}
	is AssistantPage.Setup -> when {
		assistantLeft(state, gatewayId) -> AssistantPage.Sources
		catalogued(integrationId)?.setup == null -> AssistantPage.Add
		else -> this
	}
	is AssistantPage.Device -> deviceResolved(state, devices(gatewayId))
	is AssistantPage.Source -> {
		val answered = state.gateways.assistantOn(gatewayId)
		when {
			assistantLeft(state, gatewayId) -> AssistantPage.Settings
			answered != null && sourcesOf(answered).none { it.id == sourceId } -> AssistantPage.Sources
			else -> this
		}
	}
	is AssistantPage.AutomationEditor -> if (assistantLeft(state, gatewayId)) AssistantPage.Settings else this
}

/** Home moves keep it. */
private fun AssistantPage.Device.deviceResolved(state: ChatState, list: DeviceListView?): AssistantPage = when {
	state.gateways.loaded && !state.gateways.has(gatewayId) -> AssistantPage.Sources
	list is DeviceListView.Listed && list.records.none { it.id == deviceId } -> AssistantPage.Sources
	else -> this
}

internal fun ShellNav.resolvePage(state: ChatState, devices: (String) -> DeviceListView? = { null }): ShellNav {
	val page = assistantPage ?: return this
	val now = page.resolved(state, devices)
	return if (now == page) this else copy(assistantPage = now)
}

internal fun pageWords(page: AssistantPage): List<String> = when (page) {
	AssistantPage.Settings -> listOf(PAGE_SETTINGS)
	AssistantPage.Location -> listOf(PAGE_LOCATION)
	AssistantPage.Features -> listOf(PAGE_FEATURES)
	AssistantPage.Safety -> listOf(PAGE_SAFETY)
	AssistantPage.Sources -> listOf(PAGE_SOURCES)
	AssistantPage.Automations -> listOf(PAGE_AUTOMATIONS)
	AssistantPage.Add -> listOf(PAGE_ADD)
	is AssistantPage.Entry -> listOf(PAGE_ENTRY, page.gatewayId, page.integrationId)
	is AssistantPage.Setup -> listOf(PAGE_SETUP, page.gatewayId, page.integrationId)
	is AssistantPage.Device -> listOf(PAGE_DEVICE, page.gatewayId, page.deviceId)
	is AssistantPage.Source -> listOf(PAGE_SOURCE, page.gatewayId, page.sourceId)
	is AssistantPage.AutomationEditor -> listOf(PAGE_AUTOMATION, page.gatewayId) + slotWords(page.slot)
}

internal fun pageOf(words: List<String>): AssistantPage? {
	val gatewayId = words.getOrNull(1)
	val named = words.getOrNull(2)
	return when (words.firstOrNull()) {
		PAGE_SETTINGS -> AssistantPage.Settings
		PAGE_LOCATION -> AssistantPage.Location
		PAGE_FEATURES -> AssistantPage.Features
		PAGE_SAFETY -> AssistantPage.Safety
		PAGE_SOURCES -> AssistantPage.Sources
		PAGE_AUTOMATIONS -> AssistantPage.Automations
		PAGE_ADD -> AssistantPage.Add
		PAGE_ENTRY -> if (gatewayId != null && named != null) AssistantPage.Entry(gatewayId, named) else null
		PAGE_SETUP -> if (gatewayId != null && named != null) AssistantPage.Setup(gatewayId, named) else null
		PAGE_DEVICE -> if (gatewayId != null && named != null) AssistantPage.Device(gatewayId, named) else null
		PAGE_SOURCE -> if (gatewayId != null && named != null) AssistantPage.Source(gatewayId, named) else null
		PAGE_AUTOMATION -> {
			val slot = slotOf(words.drop(2))
			if (gatewayId != null && slot != null) AssistantPage.AutomationEditor(gatewayId, slot) else null
		}
		else -> null
	}
}

/** Page keys stay unique. */
internal fun pageKey(page: AssistantPage): String = pageWords(page).joinToString(Char(0x1e).toString())

private fun slotWords(slot: AutomationSlot): List<String> = when (slot) {
	is AutomationSlot.Held -> listOf(SLOT_HELD, slot.id)
	AutomationSlot.New -> listOf(SLOT_NEW)
}

private fun slotOf(words: List<String>): AutomationSlot? = when (words.firstOrNull()) {
	SLOT_HELD -> words.getOrNull(1)?.let { AutomationSlot.Held(it) }
	SLOT_NEW -> AutomationSlot.New
	else -> null
}

private const val PAGE_SETTINGS = "settings"
private const val PAGE_LOCATION = "location"
private const val PAGE_FEATURES = "features"
private const val PAGE_SAFETY = "safety"
private const val PAGE_SOURCES = "sources"
private const val PAGE_AUTOMATIONS = "automations"
private const val PAGE_ADD = "add"
private const val PAGE_ENTRY = "entry"
private const val PAGE_SETUP = "setup"
private const val PAGE_DEVICE = "device"
private const val PAGE_SOURCE = "source"
private const val PAGE_AUTOMATION = "automation"
private const val SLOT_HELD = "held"
private const val SLOT_NEW = "new"

/** Moves retarget; a home elsewhere, nobody, or a refusal leaves. */
internal fun ShellNav.followAssistant(root: AssistantRoot, state: ChatState): ShellNav {
	val open = conversation?.takeIf { this.root == RootView.ASSISTANT } ?: return this
	return when {
		root is AssistantRoot.Placed -> if (root.team != open.team) retarget(root.team) else this
		assistantLeft(state, gatewayOf(open.team)) || homeRefusal(state) != null -> leave()
		else -> this
	}
}

/** A thread found to be the assistant's leaves the tabs. */
internal fun ChatState.withoutAssistantTabs(): ChatState {
	val kept = openTabs.filterNot { isAssistant(this, it) }
	return if (kept.size == openTabs.size) this else copy(openTabs = kept)
}
