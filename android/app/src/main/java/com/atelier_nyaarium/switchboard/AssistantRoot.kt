package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.rulesOf
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

/** Router unreached since last connect. */
internal fun routerUnreachable(state: ChatState): Boolean = !state.connected && (state.error != null || state.pollFailStreak > 0)

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

	data class Watcher(val gatewayId: String, val watcherId: String) : AssistantPage

	data class Rules(val gatewayId: String, val watcherId: String) : AssistantPage

	data class Editor(val gatewayId: String, val watcherId: String, val slot: RuleSlot) : AssistantPage
}

/** Back: Editor, Rules, Watcher, Settings. */
internal fun assistantPageBack(page: AssistantPage): AssistantPage? = when (page) {
	AssistantPage.Settings -> null
	is AssistantPage.Watcher -> AssistantPage.Settings
	is AssistantPage.Rules -> AssistantPage.Watcher(page.gatewayId, page.watcherId)
	is AssistantPage.Editor -> AssistantPage.Rules(page.gatewayId, page.watcherId)
}

/** Only answers unwind pages. */
internal fun AssistantPage.resolved(state: ChatState): AssistantPage {
	val (gatewayId, watcherId) = when (this) {
		AssistantPage.Settings -> return this
		is AssistantPage.Watcher -> gatewayId to watcherId
		is AssistantPage.Rules -> gatewayId to watcherId
		is AssistantPage.Editor -> gatewayId to watcherId
	}
	if (assistantLeft(state, gatewayId)) return AssistantPage.Settings
	val answered = state.gateways.assistantOn(gatewayId) ?: return this
	val watcher = answered.watchers.find { it.id == watcherId } ?: return AssistantPage.Settings
	return if (this is AssistantPage.Watcher || rulesOf(watcher) != null) this else AssistantPage.Watcher(gatewayId, watcherId)
}

internal fun ShellNav.resolvePage(state: ChatState): ShellNav {
	val page = assistantPage ?: return this
	val now = page.resolved(state)
	return if (now == page) this else copy(assistantPage = now)
}

internal fun pageWords(page: AssistantPage): List<String> = when (page) {
	AssistantPage.Settings -> listOf(PAGE_SETTINGS)
	is AssistantPage.Watcher -> listOf(PAGE_WATCHER, page.gatewayId, page.watcherId)
	is AssistantPage.Rules -> listOf(PAGE_RULES, page.gatewayId, page.watcherId)
	is AssistantPage.Editor -> listOf(PAGE_EDITOR, page.gatewayId, page.watcherId) + slotWords(page.slot)
}

internal fun pageOf(words: List<String>): AssistantPage? {
	val gatewayId = words.getOrNull(1)
	val watcherId = words.getOrNull(2)
	return when (words.firstOrNull()) {
		PAGE_SETTINGS -> AssistantPage.Settings
		PAGE_WATCHER -> if (gatewayId != null && watcherId != null) AssistantPage.Watcher(gatewayId, watcherId) else null
		PAGE_RULES -> if (gatewayId != null && watcherId != null) AssistantPage.Rules(gatewayId, watcherId) else null
		PAGE_EDITOR -> {
			val slot = slotOf(words.drop(3))
			if (gatewayId != null && watcherId != null && slot != null) AssistantPage.Editor(gatewayId, watcherId, slot) else null
		}
		else -> null
	}
}

/** Page keys stay unique. */
internal fun pageKey(page: AssistantPage): String = pageWords(page).joinToString(Char(0x1e).toString())

private fun slotWords(slot: RuleSlot): List<String> = when (slot) {
	is RuleSlot.Held -> listOf(SLOT_HELD, slot.id)
	RuleSlot.New -> listOf(SLOT_NEW)
	RuleSlot.Otherwise -> listOf(SLOT_OTHERWISE)
}

private fun slotOf(words: List<String>): RuleSlot? = when (words.firstOrNull()) {
	SLOT_HELD -> words.getOrNull(1)?.let { RuleSlot.Held(it) }
	SLOT_NEW -> RuleSlot.New
	SLOT_OTHERWISE -> RuleSlot.Otherwise
	else -> null
}

private const val PAGE_SETTINGS = "settings"
private const val PAGE_WATCHER = "watcher"
private const val PAGE_RULES = "rules"
private const val PAGE_EDITOR = "editor"
private const val SLOT_HELD = "held"
private const val SLOT_NEW = "new"
private const val SLOT_OTHERWISE = "otherwise"

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
