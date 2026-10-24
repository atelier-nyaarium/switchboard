package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.parseSessionName

/** What the Assistant root shows. */
internal sealed interface AssistantRoot {
	data class Placed(val team: String) : AssistantRoot

	data object Unplaced : AssistantRoot

	/** A Gateway that may hold it has not answered yet. */
	data object Loading : AssistantRoot

	/** A possible home is unread. `canPlace`: refusals only. */
	data class Unavailable(val canPlace: Boolean) : AssistantRoot
}

/** The Gateway's answered address. */
internal fun answeredAssistant(state: ChatState, gatewayId: String): String? {
	val team = state.gateways.assistantOn(gatewayId)?.team ?: return null
	val domainId = state.domainId ?: return null
	return runIsolated {
		val name = parseSessionName(team)
		Address.of(domainId, gatewayId, name.project, name.session).canonical
	}.getOrNull()
}

/** Stamp or answer, never the name. */
internal fun isAssistant(state: ChatState, team: String): Boolean =
	(state.teams.firstOrNull { it.name == team }?.role ?: state.roles[team]) == ASSISTANT_ROLE ||
		state.gateways.ids().any { answeredAssistant(state, it) == team }

/** Where it lives now; the persisted cache only identifies past homes. */
internal fun assistantTeams(state: ChatState): Set<String> =
	state.teams.filter { it.role == ASSISTANT_ROLE }.map { it.name }.toSet() +
		state.gateways.ids().mapNotNull { answeredAssistant(state, it) }

/** `preferred` wins, then a reachable home. */
internal fun assistantHome(state: ChatState, preferred: String?): String? {
	val homes = state.gateways.assistantHomes()
	return homes.firstOrNull { it == preferred }
		?: homes.firstOrNull { state.gateways.reachable(it) }
		?: homes.firstOrNull()
}

internal fun assistantRoot(state: ChatState, preferred: String?): AssistantRoot {
	val registry = state.gateways
	val home = assistantHome(state, preferred)
	if (home != null && !registry.reachable(home)) {
		return if (registry.current) AssistantRoot.Unavailable(canPlace = false) else AssistantRoot.Loading
	}
	if (home != null) return answeredAssistant(state, home)?.let { AssistantRoot.Placed(it) } ?: AssistantRoot.Loading
	val unread = registry.gateways.filter { it.assistant !is AssistantWord.Answered }
	return when {
		!registry.current -> AssistantRoot.Loading
		unread.isEmpty() -> AssistantRoot.Unplaced
		unread.any { it.assistant == null && registry.reachable(it.id) } -> AssistantRoot.Loading
		else -> AssistantRoot.Unavailable(canPlace = unread.all { it.assistant is AssistantWord.Refused })
	}
}

/** Answered gone, or unlisted. */
internal fun assistantReleased(state: ChatState, gatewayId: String): Boolean {
	val registry = state.gateways
	val word = registry.entry(gatewayId)?.assistant as? AssistantWord.Answered
		?: return registry.current && !registry.has(gatewayId)
	return word.state.workdir == null
}

/** Enters once placed, never over Settings. */
internal fun ShellNav.enterAssistant(root: AssistantRoot, facts: (String) -> ArrivalFacts): ShellNav {
	if (this.root != RootView.ASSISTANT || conversation != null || settings != null) return this
	val placed = root as? AssistantRoot.Placed ?: return this
	return arriveAt(placed.team, assistant = true, Arrival.OUTSIDE, facts(placed.team))
}

/** Moves retarget; releases leave. */
internal fun ShellNav.followAssistant(root: AssistantRoot, state: ChatState): ShellNav {
	val open = conversation?.takeIf { this.root == RootView.ASSISTANT } ?: return this
	return when {
		root is AssistantRoot.Placed -> if (root.team != open.team) retarget(root.team) else this
		assistantReleased(state, gatewayOf(open.team)) -> leave()
		else -> this
	}
}

/** A thread found to be the assistant's leaves the tabs. */
internal fun ChatState.withoutAssistantTabs(): ChatState {
	val kept = openTabs.filterNot { isAssistant(this, it) }
	return if (kept.size == openTabs.size) this else copy(openTabs = kept)
}
