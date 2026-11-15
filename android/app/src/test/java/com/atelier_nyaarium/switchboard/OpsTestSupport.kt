package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow

internal class TestIdentityPort(private val store: AppStateStore, private val boot: PhoneBootstrap? = null) : IdentityPort {
	private val federationValue = FederationManager(store)
	override fun readyOrNull(): PhoneBootstrap? = boot
	override suspend fun ready(): PhoneBootstrap = boot ?: error("unused")
	override fun ownerOpsOrNull(): OwnerOps? = null
	override fun ensureContentEpochs(boot: PhoneBootstrap) = Unit
	override val federation get() = federationValue
}

internal object FailingClientPort : ClientPort {
	override fun client(): ConsoleClient = error("unused")
	override fun transport(): ConsoleRouterTransport = error("unused")
}

internal object IdlePresencePort : PresencePort {
	override suspend fun refreshAfterAction() = Unit
	override suspend fun reapplyCachedTeams() = Unit
	override suspend fun restoreLastProjection() = Unit
}

/** Counts what a session or drain action asked presence for. */
internal class RecordingPresencePort : PresencePort {
	var refreshes = 0
	var reapplies = 0
	var restores = 0

	override suspend fun refreshAfterAction() { refreshes++ }
	override suspend fun reapplyCachedTeams() { reapplies++ }
	override suspend fun restoreLastProjection() { restores++ }
}

/** Current roster of connected Gateways. */
internal fun testRegistry(
	vararg ids: String,
	provenance: RegistryProvenance = RegistryProvenance.Current,
): GatewayRegistry = GatewayRegistry(
	provenance = provenance,
	epoch = 1,
	version = 1,
	gateways = ids.map { GatewayEntry(it, connected = true, incarnation = 1, lastRegisteredAt = 1) }.sortedBy { it.id },
)

/** Re-provision around [wipe]. */
internal inline fun ProvisionFence.reprovision(wipe: () -> Unit = {}) {
	advance()
	try {
		wipe()
	} finally {
		settle()
	}
}

/** Weekly routine pinning [runbookId]. */
internal fun testRoutine(id: String, runbookId: String = "book") = com.atelier_nyaarium.switchboard.proto.Routine(
	id = id,
	name = id,
	weekdays = listOf(1L),
	weekInterval = 1L,
	startDate = "2026-01-05",
	time = "09:00",
	zone = "America/Los_Angeles",
	runbookId = runbookId,
	approvedRevision = 1L,
	values = kotlinx.serialization.json.JsonObject(emptyMap()),
	target = com.atelier_nyaarium.switchboard.proto.RoutineTarget(spawn = "host"),
	linkedEntries = emptyList(),
	enabled = true,
	revision = 1L,
	since = 0L,
	forgetAfterDays = 30L,
)

/** The link after these events, each [stepMs] after the last. */
internal fun linkAfter(vararg events: RouterEvent, stepMs: Long = 1_000L): RouterLink {
	val state = MutableStateFlow(ChatState())
	var now = 0L
	val writer = RouterLink.Writer(state) { now }
	for (event in events) {
		now += stepMs
		writer.note(event)
	}
	return state.value.router
}

/** Setup settled, the Router answering. */
internal fun onlineLink(): RouterLink = linkAfter(RouterEvent.Accepted, RouterEvent.SetupSettled)
