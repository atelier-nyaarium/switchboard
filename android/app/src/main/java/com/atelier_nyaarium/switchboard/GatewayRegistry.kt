package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.AutomationRow
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

/** Only `Listed` has rows. */
sealed interface GatewayList<out T> {
	/** Never asked. */
	data object Unread : GatewayList<Nothing>

	data class Listed<T>(val rows: List<T>) : GatewayList<T>

	data object NotServed : GatewayList<Nothing>

	/** Asked; nothing came back. */
	data object Unreachable : GatewayList<Nothing>
}

sealed interface Lookup<out T> {
	data class Found<T>(val row: T) : Lookup<T>

	/** Its list answered without it. */
	data object Gone : Lookup<Nothing>

	data object Reading : Lookup<Nothing>

	data object Unreachable : Lookup<Nothing>

	data object NotServed : Lookup<Nothing>
}

fun <T> GatewayList<T>.lookup(match: (T) -> Boolean): Lookup<T> = when (this) {
	is GatewayList.Listed -> rows.find(match)?.let { Lookup.Found(it) } ?: Lookup.Gone
	GatewayList.Unread -> Lookup.Reading
	GatewayList.Unreachable -> Lookup.Unreachable
	GatewayList.NotServed -> Lookup.NotServed
}

data class ListedGroup<T>(val gatewayId: String, val rows: List<T>)

/** Only listed Gateways draw a group. */
fun <T> List<GatewayEntry>.listedGroups(of: (GatewayEntry) -> GatewayList<T>): List<ListedGroup<T>> =
	mapNotNull { entry ->
		when (val list = of(entry)) {
			is GatewayList.Listed -> ListedGroup(entry.id, list.rows)
			GatewayList.Unread, GatewayList.Unreachable, GatewayList.NotServed -> null
		}
	}

sealed interface ListEmpty {
	data object NoRoster : ListEmpty

	/** A first read is out. */
	data object Reading : ListEmpty

	data object Unreachable : ListEmpty

	data class NotServed(val gatewayIds: List<String>) : ListEmpty

	/** No Gateway in scope. */
	data object NoGateway : ListEmpty

	data object None : ListEmpty
}

/** Answered outranks unread. */
fun <T> listEmpty(registry: GatewayRegistry, entries: List<GatewayEntry>, of: (GatewayEntry) -> GatewayList<T>): ListEmpty {
	val lists = entries.map { it.id to of(it) }
	return when {
		!registry.loaded -> ListEmpty.NoRoster
		lists.any { it.second is GatewayList.Listed } -> ListEmpty.None
		lists.any { it.second == GatewayList.Unread } -> ListEmpty.Reading
		lists.any { it.second == GatewayList.Unreachable } -> ListEmpty.Unreachable
		lists.isNotEmpty() -> ListEmpty.NotServed(lists.map { it.first })
		else -> ListEmpty.NoGateway
	}
}

fun emptyLine(empty: ListEmpty, noun: String): String = when (empty) {
	ListEmpty.NoRoster -> "No roster yet"
	ListEmpty.Reading -> "Reading $noun"
	ListEmpty.Unreachable -> "No Gateway could be read"
	is ListEmpty.NotServed -> "${empty.gatewayIds.joinToString(", ")} does not serve $noun"
	ListEmpty.NoGateway -> "No Gateway to read"
	ListEmpty.None -> "No $noun"
}

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
	val routines: GatewayList<RoutineState> = GatewayList.Unread,
	val runbooks: GatewayList<Runbook> = GatewayList.Unread,
	val policies: GatewayList<AuthorizationPolicy> = GatewayList.Unread,
	val automations: GatewayList<AutomationRow> = GatewayList.Unread,
	/** Read only by `automationContext`. */
	val automationServes: com.atelier_nyaarium.switchboard.proto.AutomationServes? = null,
	val peers: GatewayList<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry> = GatewayList.Unread,
	val assistant: AssistantRead = AssistantRead.Reading,
) {
	val seen: Boolean get() = incarnation > 0
}

/** A Gateway's own answer; a refusal says nothing. */
sealed interface AssistantWord {
	data class Answered(val state: ConsoleAssistantStateResult) : AssistantWord

	/** Unsupported op or fault. */
	data object Refused : AssistantWord
}

internal fun readOf(word: AssistantWord): AssistantRead = when (word) {
	is AssistantWord.Answered -> AssistantRead.Answered(word.state)
	AssistantWord.Refused -> AssistantRead.Refused
}

/** A Gateway's word on the assistant, as a reader must tell it apart. */
sealed interface AssistantRead {
	data class Answered(val state: ConsoleAssistantStateResult) : AssistantRead

	data object Reading : AssistantRead

	data object Refused : AssistantRead
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

	/** Off the roster: unread before the roster loads, unreachable after. */
	fun <T> listOn(gatewayId: String, of: (GatewayEntry) -> GatewayList<T>): GatewayList<T> =
		entry(gatewayId)?.let(of) ?: if (loaded) GatewayList.Unreachable else GatewayList.Unread

	private fun <T> lookup(gatewayId: String, of: (GatewayEntry) -> GatewayList<T>, match: (T) -> Boolean): Lookup<T> =
		listOn(gatewayId, of).lookup(match)

	fun runbookOn(gatewayId: String, runbookId: String): Lookup<Runbook> = lookup(gatewayId, { it.runbooks }) { it.id == runbookId }

	fun routineOn(gatewayId: String, routineId: String): Lookup<RoutineState> =
		lookup(gatewayId, { it.routines }) { it.routine.id == routineId }

	fun policyOn(gatewayId: String, policyId: String): Lookup<AuthorizationPolicy> =
		lookup(gatewayId, { it.policies }) { it.id == policyId }

	fun automationOn(gatewayId: String, automationId: String): Lookup<AutomationRow> =
		lookup(gatewayId, { it.automations }) { it.id == automationId }

	/** Off the roster as [listOn]. */
	fun assistantRead(gatewayId: String): AssistantRead =
		entry(gatewayId)?.assistant ?: if (loaded) AssistantRead.Refused else AssistantRead.Reading

	/** Drops every held assistant answer. */
	fun withoutAssistantWords(): GatewayRegistry = copy(gateways = gateways.map { it.copy(assistant = AssistantRead.Reading) })

	/** Wake at earliest routine. */
	fun soonestRoutineAt(): Long? =
		gateways.listedGroups { it.routines }.flatMap { group -> group.rows.mapNotNull { it.nextAt } }.minOrNull()

	/** Same incarnation keeps every answer. */
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
					val point = points[row.gatewayId]
					// Restarted answers are discarded.
					val prior = kept[row.gatewayId]?.takeIf { it.incarnation == row.incarnation }
					val base = prior ?: GatewayEntry(
						id = row.gatewayId,
						connected = row.connected,
						incarnation = row.incarnation,
						lastRegisteredAt = row.lastRegisteredAt,
						runbooks = storedRunbooks(row.gatewayId)?.let { GatewayList.Listed(it) } ?: GatewayList.Unread,
						// Pairings outlive a restart, so the last answer stands.
						peers = kept[row.gatewayId]?.peers ?: GatewayList.Unread,
					)
					base.copy(
						connected = row.connected,
						incarnation = row.incarnation,
						lastRegisteredAt = row.lastRegisteredAt,
						hostSpawns = point?.hostSpawns,
						harnessSpawns = point?.let(::harnessSpawnsOf),
						containers = point?.containers?.let(::addressableContainers),
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

/** Drops a container with no address segment. */
internal fun addressableContainers(rows: List<ContainerState>): List<SpawnContainer> =
	rows.filter { isSlug(it.project) }.map(::spawnContainerOf)

/** A container row; a CLI word this build cannot launch is dropped. A row not running carries its last look's list, read as unopened. */
internal fun spawnContainerOf(row: ContainerState): SpawnContainer {
	val run = ContainerRun.of(row.state)
	val looked = row.clis.takeIf { run == ContainerRun.RUNNING }
	return SpawnContainer(
		project = row.project,
		run = run,
		failure = row.failure,
		harnesses = looked?.let { words ->
			SpawnHarnesses.Known(words.mapNotNullTo(HashSet()) { (readHarness(it) as? HarnessWord.Named)?.harness })
		} ?: SpawnHarnesses.UNOPENED_CONTAINER,
	)
}

// FIXME 2026-11-23: drop, with both old lists.
/** An older Gateway's lists. With no Claude list it ran Claude on every host spawn point. */
private fun legacySpawns(claude: List<String>?, copilot: List<String>?): Map<SessionHarness, List<String>> =
	mapOf(
		SessionHarness.CLAUDE to (claude ?: HOST_SPAWN_IDS.toList()),
		SessionHarness.COPILOT to copilot.orEmpty(),
	)
