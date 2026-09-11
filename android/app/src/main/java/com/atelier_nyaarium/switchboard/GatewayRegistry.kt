package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.Runbook

/** `NeverLoaded` differs from empty. */
enum class RegistryProvenance { NeverLoaded, Cached, Current }

/** What the roster says about one Gateway. */
enum class GatewayStanding { Unknown, NeverSeen, Offline, Online }

data class GatewayEntry(
	val id: String,
	val connected: Boolean,
	val incarnation: Long,
	val lastRegisteredAt: Long,
	/** Null until the Gateway projects its spawn points. */
	val hostSpawns: List<String>? = null,
	val routines: List<RoutineState>? = null,
	/** Schedule zone from answer. */
	val routineZone: String = "",
	val runbooks: List<Runbook>? = null,
	val policies: List<AuthorizationPolicy>? = null,
) {
	val seen: Boolean get() = incarnation > 0
}

data class GatewayRegistry(
	val provenance: RegistryProvenance = RegistryProvenance.NeverLoaded,
	val epoch: Long = 0,
	val version: Long = 0,
	val coverage: DiscoverCoverage? = null,
	val gateways: List<GatewayEntry> = emptyList(),
) {
	val loaded: Boolean get() = provenance != RegistryProvenance.NeverLoaded
	val current: Boolean get() = provenance == RegistryProvenance.Current

	fun ids(): List<String> = gateways.map { it.id }

	fun entry(gatewayId: String): GatewayEntry? = gateways.find { it.id == gatewayId }

	fun has(gatewayId: String): Boolean = entry(gatewayId) != null

	/** Null means roster unknown. */
	fun connected(gatewayId: String): Boolean? = entry(gatewayId)?.connected

	fun hostSpawns(gatewayId: String): List<String>? = entry(gatewayId)?.hostSpawns

	/** Roster live, Router-held. */
	fun reachable(gatewayId: String): Boolean = current && connected(gatewayId) == true

	fun reachableIds(): List<String> = if (current) gateways.filter { it.connected }.map { it.id } else emptyList()

	/** May offer a spawn: roster loaded, connection held, spawn points projected. */
	fun offersSpawn(gatewayId: String): Boolean = loaded && connected(gatewayId) == true && hostSpawns(gatewayId) != null

	fun standing(gatewayId: String): GatewayStanding {
		val entry = if (loaded) entry(gatewayId) else null
		return when {
			entry == null -> GatewayStanding.Unknown
			!entry.seen -> GatewayStanding.NeverSeen
			entry.connected -> GatewayStanding.Online
			else -> GatewayStanding.Offline
		}
	}

	/** Re-ask on incarnation change. */
	fun incarnations(): List<Pair<String, Long>> = gateways.map { it.id to it.incarnation }

	/** Records stay Gateway-scoped. */
	fun runbooksOn(gatewayId: String): List<Runbook> = entry(gatewayId)?.runbooks.orEmpty()

	fun runbookOn(gatewayId: String, runbookId: String): Runbook? = runbooksOn(gatewayId).find { it.id == runbookId }

	fun routinesOn(gatewayId: String): List<RoutineState> = entry(gatewayId)?.routines.orEmpty()

	fun routineOn(gatewayId: String, routineId: String): RoutineState? =
		routinesOn(gatewayId).find { it.routine.id == routineId }

	fun policiesOn(gatewayId: String): List<AuthorizationPolicy> = entry(gatewayId)?.policies.orEmpty()

	fun policyOn(gatewayId: String, policyId: String): AuthorizationPolicy? =
		policiesOn(gatewayId).find { it.id == policyId }

	/** Wake at earliest routine. */
	fun soonestRoutineAt(): Long? =
		gateways.flatMap { entry -> entry.routines.orEmpty().mapNotNull { it.nextAt } }.minOrNull()

	/** Roster membership preserves answers. */
	fun landed(
		projection: OwnerPresenceProjection,
		provenance: RegistryProvenance,
		storedRunbooks: (String) -> List<Runbook>?,
	): GatewayRegistry {
		val spawns = projection.spawnPoints.associate { it.gatewayId to it.hostSpawns }
		val kept = gateways.associateBy { it.id }
		return GatewayRegistry(
			provenance = provenance,
			epoch = projection.plane.epoch,
			version = projection.plane.version,
			coverage = projection.coverage,
			gateways = projection.roster
				.map { row ->
					// Restarted answers are discarded.
					val prior = kept[row.gatewayId]?.takeIf { it.incarnation == row.incarnation }
					GatewayEntry(
						id = row.gatewayId,
						connected = row.connected,
						incarnation = row.incarnation,
						lastRegisteredAt = row.lastRegisteredAt,
						hostSpawns = spawns[row.gatewayId],
						routines = prior?.routines,
						routineZone = prior?.routineZone.orEmpty(),
						runbooks = prior?.runbooks ?: storedRunbooks(row.gatewayId),
						policies = prior?.policies,
					)
				}
				.sortedBy { it.id },
		)
	}

	/** Dropped Gateways draw nothing. */
	fun withEntry(gatewayId: String, change: (GatewayEntry) -> GatewayEntry): GatewayRegistry =
		if (!has(gatewayId)) this else copy(gateways = gateways.map { if (it.id == gatewayId) change(it) else it })
}
