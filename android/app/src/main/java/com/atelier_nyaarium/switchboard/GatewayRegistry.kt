package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ContainerState
import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.isSlug
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import com.atelier_nyaarium.switchboard.proto.readHarness
import com.atelier_nyaarium.switchboard.proto.spawnsOf

/** `NeverLoaded` differs from empty. */
enum class RegistryProvenance { NeverLoaded, Cached, Current }

/** What the roster says about one Gateway. */
enum class GatewayStanding { Unknown, NeverSeen, Offline, Online }

/** The session CLIs one spawn point has. */
sealed interface SpawnHarnesses {
	/** Nobody has looked yet; `runsHere` is what the place allows. */
	data class Unknown(val runsHere: Set<SessionHarness>) : SpawnHarnesses

	data class Known(val installed: Set<SessionHarness>) : SpawnHarnesses

	companion object {
		/** A container nobody has looked inside. */
		val UNOPENED_CONTAINER = Unknown(SessionHarness.entries.filter { it.containers }.toSet())
	}
}

/** A dev container's run state, as its Gateway reports it. */
enum class ContainerRun(val wire: String) {
	STOPPED("stopped"),
	STARTING("starting"),
	RUNNING("running"),
	;

	companion object {
		/** Null for a newer Gateway's word. */
		fun of(wire: String): ContainerRun? = entries.find { it.wire == wire }
	}
}

/** One advertised dev container. */
data class SpawnContainer(
	val project: String,
	val run: ContainerRun?,
	/** The last Start or Stop that failed. */
	val failure: String?,
	val harnesses: SpawnHarnesses,
)

data class GatewayEntry(
	val id: String,
	val connected: Boolean,
	val incarnation: Long,
	val lastRegisteredAt: Long,
	/** Null until the Gateway projects its spawn points. */
	val hostSpawns: List<String>? = null,
	/** Spawn points per CLI. Null with no row. */
	val harnessSpawns: Map<SessionHarness, List<String>>? = null,
	/** Null from a Gateway that reports none. */
	val containers: List<SpawnContainer>? = null,
	val routines: List<RoutineState>? = null,
	val runbooks: List<Runbook>? = null,
	val policies: List<AuthorizationPolicy>? = null,
	val peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>? = null,
	val assistant: AssistantWord? = null,
) {
	val seen: Boolean get() = incarnation > 0
}

/** A Gateway's own answer; a refusal says nothing. */
sealed interface AssistantWord {
	data class Answered(val state: ConsoleAssistantStateResult) : AssistantWord

	/** Unsupported op or fault. */
	data object Refused : AssistantWord
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

	/** [harnessesOn] for a session's spawn point. */
	fun harnessesOnSession(address: String): SpawnHarnesses {
		val parsed = runIsolated { parseQualifiedTarget(address) }.getOrNull() as? Address
			?: return SpawnHarnesses.UNOPENED_CONTAINER
		return harnessesOn(parsed.gateway, parsed.spawn)
	}

	/** Which session CLIs a spawn point can run. */
	fun harnessesOn(gatewayId: String, spawn: String): SpawnHarnesses {
		if (spawn !in HOST_SPAWN_IDS) return container(gatewayId, spawn)?.harnesses ?: SpawnHarnesses.UNOPENED_CONTAINER
		// No row reads as an older Gateway.
		val held = entry(gatewayId)?.harnessSpawns ?: legacySpawns(claude = null, copilot = null)
		return SpawnHarnesses.Known(SessionHarness.entries.filter { held[it]?.contains(spawn) == true }.toSet())
	}

	fun containersOn(gatewayId: String): List<SpawnContainer> = entry(gatewayId)?.containers.orEmpty()

	fun container(gatewayId: String, project: String): SpawnContainer? =
		containersOn(gatewayId).find { it.project == project }

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

	fun peersOn(gatewayId: String): List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry> = entry(gatewayId)?.peers.orEmpty()

	fun hasPeer(gatewayId: String, domainId: String): Boolean = entry(gatewayId)?.peers?.any { it.domainId == domainId } == true

	/** Its watchers, rules and Safety; placement is the Router's. */
	fun assistantOn(gatewayId: String): ConsoleAssistantStateResult? =
		(entry(gatewayId)?.assistant as? AssistantWord.Answered)?.state

	/** Answers predating a new choice. */
	fun withoutAssistantWords(): GatewayRegistry = copy(gateways = gateways.map { it.copy(assistant = null) })

	/** Wake at earliest routine. */
	fun soonestRoutineAt(): Long? =
		gateways.flatMap { entry -> entry.routines.orEmpty().mapNotNull { it.nextAt } }.minOrNull()

	/** Roster membership preserves answers. */
	fun landed(
		projection: OwnerPresenceProjection,
		provenance: RegistryProvenance,
		storedRunbooks: (String) -> List<Runbook>?,
	): GatewayRegistry {
		val points = projection.spawnPoints.associateBy { it.gatewayId }
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
						hostSpawns = points[row.gatewayId]?.hostSpawns,
						harnessSpawns = points[row.gatewayId]?.let(::harnessSpawnsOf),
						containers = points[row.gatewayId]?.containers?.let(::addressableContainers),
						routines = prior?.routines,
						runbooks = prior?.runbooks ?: storedRunbooks(row.gatewayId),
						policies = prior?.policies,
						peers = prior?.peers,
						assistant = prior?.assistant,
					)
				}
				.sortedBy { it.id },
		)
	}

	/** Dropped Gateways draw nothing. */
	fun withEntry(gatewayId: String, change: (GatewayEntry) -> GatewayEntry): GatewayRegistry =
		if (!has(gatewayId)) this else copy(gateways = gateways.map { if (it.id == gatewayId) change(it) else it })
}

/** Per CLI, the spawn points a Gateway's row names. */
internal fun harnessSpawnsOf(row: GatewaySpawnPoints): Map<SessionHarness, List<String>> {
	val sent = row.harnessSpawns ?: return legacySpawns(row.claudeSpawns, row.copilotSpawns)
	return SessionHarness.entries.associateWith { sent.spawnsOf(it).orEmpty() }
}

/** A container whose project is no address segment is dropped. */
internal fun addressableContainers(rows: List<ContainerState>): List<SpawnContainer> =
	rows.filter { isSlug(it.project) }.map(::spawnContainerOf)

/** A container row; a CLI word this build cannot launch is dropped. */
internal fun spawnContainerOf(row: ContainerState): SpawnContainer =
	SpawnContainer(
		project = row.project,
		run = ContainerRun.of(row.state),
		failure = row.failure,
		harnesses = row.clis?.let { words ->
			SpawnHarnesses.Known(words.mapNotNullTo(HashSet()) { (readHarness(it) as? HarnessWord.Named)?.harness })
		} ?: SpawnHarnesses.UNOPENED_CONTAINER,
	)

// FIXME 2026-11-23: drop, with both old lists.
/** An older Gateway's lists. With no Claude list it ran Claude on every host spawn point. */
private fun legacySpawns(claude: List<String>?, copilot: List<String>?): Map<SessionHarness, List<String>> =
	mapOf(
		SessionHarness.CLAUDE to (claude ?: HOST_SPAWN_IDS.toList()),
		SessionHarness.COPILOT to copilot.orEmpty(),
	)
