package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow

internal interface PresenceHost {
	val state: MutableStateFlow<ChatState>
	val homeGatewayId: String
	var storedDisplayName: String
	val forgottenUntil: MutableMap<String, Long>

	suspend fun <T> withDrainMutex(block: suspend () -> T): T
	suspend fun reportRead(team: String, anchor: ReadAnchor)
	/** Reads the planes past the cursor and lands them; `everything` asks for all of them. */
	suspend fun pullPlanes(everything: Boolean = false)
	/** Stored runbooks for a Gateway, or null. */
	fun storedRunbooks(gatewayId: String): List<com.atelier_nyaarium.switchboard.proto.Runbook>?

	fun loadRouterState(kind: String): RouterStateSlot?
	fun saveRouterState(kind: String, slot: RouterStateSlot)
	fun persistLabels(labels: Map<String, String>)
	fun persistAbsenceStreaks(streaks: Map<String, Int>)
	fun persistReadAnchors(anchors: Map<String, ReadAnchor>)
	fun receiptFor(team: String, now: Long): ActionReceipt?
	fun clearReceipt(team: String)
}

internal class ChatRepositoryPresenceHost(private val repo: ChatRepository) : PresenceHost {
	override val state get() = repo._state
	override val homeGatewayId get() = repo.homeGatewayId
	override var storedDisplayName
		get() = repo.store.displayName
		set(value) { repo.store.displayName = value }
	override val forgottenUntil get() = repo.forgottenUntil

	override suspend fun <T> withDrainMutex(block: suspend () -> T): T = repo.drainGate.withDrainMutex(block)
	override suspend fun reportRead(team: String, anchor: ReadAnchor) {
		repo.client().reportRead(team, anchor)
	}
	override suspend fun pullPlanes(everything: Boolean) = repo.drain.pullPlanes(everything)
	override fun storedRunbooks(gatewayId: String) = repo.runbooks.placed()[gatewayId]
	override fun loadRouterState(kind: String) = repo.store.loadRouterState(kind)
	override fun saveRouterState(kind: String, slot: RouterStateSlot) = repo.store.saveRouterState(kind, slot)
	override fun persistLabels(labels: Map<String, String>) = repo.persistence.persistLabels(labels)
	override fun persistAbsenceStreaks(streaks: Map<String, Int>) = repo.persistence.persistAbsenceStreaks(streaks)
	override fun persistReadAnchors(anchors: Map<String, ReadAnchor>) = repo.persistence.persistReadAnchors(anchors)
	override fun receiptFor(team: String, now: Long) = repo.sessions.receiptFor(team, now)
	override fun clearReceipt(team: String) = repo.sessions.clearReceipt(team)
}
