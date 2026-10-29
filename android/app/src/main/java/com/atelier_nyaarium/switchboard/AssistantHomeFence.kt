package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet

/** Which choice a home effect began under. */
internal sealed interface HomeChoice {
	data object Unread : HomeChoice

	data object NeverWritten : HomeChoice

	data class At(val version: Long) : HomeChoice
}

internal fun choiceOf(home: AssistantHome): HomeChoice = when (home) {
	AssistantHome.Unread -> HomeChoice.Unread
	is AssistantHome.Read -> home.record?.let { HomeChoice.At(it.version) } ?: HomeChoice.NeverWritten
}

/** Taken before an await; a landing checks it. */
internal data class HomeTicket(val generation: Long, val held: AssistantHome) {
	val choice: HomeChoice get() = choiceOf(held)
}

internal sealed interface HomeEffect {
	/** Needs only the generation; `newerHome` orders versions. */
	data class Record(val home: AssistantHome.Read) : HomeEffect

	data class Word(val gatewayId: String, val word: AssistantWord) : HomeEffect

	/** Null clears. */
	data class Failure(val reason: String?) : HomeEffect
}

internal enum class HomeLanding { Landed, Current, Stale }

/** Null when the effect lands nothing. */
internal fun homeLanding(state: ChatState, generation: Long, ticket: HomeTicket, effect: HomeEffect): ChatState? {
	if (ticket.generation != generation) return null
	val held = state.assistantHome
	if (effect !is HomeEffect.Record && choiceOf(held) != ticket.choice) return null
	return when (effect) {
		is HomeEffect.Record -> {
			val home = newerHome(held, effect.home) ?: return state
			val landed = state.copy(assistantHome = home).withoutAssistantTabs()
			if (choiceOf(held) == choiceOf(home)) {
				landed
			} else {
				landed.copy(gateways = landed.gateways.withoutAssistantWords(), homeFailure = null)
			}
		}
		is HomeEffect.Word ->
			state.copy(gateways = state.gateways.withEntry(effect.gatewayId) { it.copy(assistant = effect.word) }).withoutAssistantTabs()
		is HomeEffect.Failure -> state.copy(homeFailure = effect.reason)
	}
}

/** The home's one writer; nothing it wraps suspends. */
internal class AssistantHomeFence(
	private val state: MutableStateFlow<ChatState>,
	private val persist: (AssistantHome.Read) -> Unit,
	private val persistRoles: (Map<String, String>) -> Unit,
) {
	private val lock = Any()
	private var generation = 0L

	fun begin(): HomeTicket = synchronized(lock) { HomeTicket(generation, state.value.assistantHome) }

	fun holds(ticket: HomeTicket): Boolean = synchronized(lock) { ticket.generation == generation }

	/** Same generation and the same choice still held. */
	fun current(ticket: HomeTicket): Boolean =
		synchronized(lock) { ticket.generation == generation && choiceOf(state.value.assistantHome) == ticket.choice }

	fun land(ticket: HomeTicket, effect: HomeEffect): HomeLanding = synchronized(lock) { landHeld(ticket, effect) }

	private fun landHeld(ticket: HomeTicket, effect: HomeEffect): HomeLanding {
		// Other writers share the state, so compare and set.
		while (true) {
			val before = state.value
			val after = homeLanding(before, generation, ticket, effect) ?: return HomeLanding.Stale
			if (after != before && !state.compareAndSet(before, after)) continue
			if (effect is HomeEffect.Record) {
				(after.assistantHome as? AssistantHome.Read)?.takeIf { it != before.assistantHome }?.let(persist)
				stampPlaced()
			}
			return if (after == before) HomeLanding.Current else HomeLanding.Landed
		}
	}

	/** A re-provision: what was read names another Domain. */
	fun across(provision: () -> Unit) = synchronized(lock) {
		generation++
		state.update { it.copy(assistantHome = AssistantHome.Unread, homeFailure = null) }
		provision()
	}

	/** Idempotent; any record landing repairs it. */
	private fun stampPlaced() {
		val address = placedAddress(state.value) ?: return
		if (state.value.roles[address] == ASSISTANT_ROLE) return
		persistRoles(state.updateAndGet { it.copy(roles = it.roles + (address to ASSISTANT_ROLE)) }.roles)
	}
}
