package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.TeamInfo
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import com.atelier_nyaarium.switchboard.proto.readHarness
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

////////////////////////////////
//  Constants

/** A real Gateway answers after a round trip. */
private const val CONTAINER_ROUND_TRIP_MS = 600L

/** How long a sandbox start builds before it runs. */
private const val CONTAINER_BUILD_MS = 3_000L

/** Long enough to re-press Create while waking. */
private const val SESSION_START_MS = 20_000L

////////////////////////////////
//  Functions & Helpers

private const val SANDBOX_LAUNCH_FAILURE = "Copilot was not installed."

/** Gateway `index`'s containers, so each answers differently; the last reports none. */
internal fun sandboxContainers(index: Int): List<SpawnContainer> = when (index) {
	0 -> listOf(
		SpawnContainer(
			"recipe-app",
			ContainerRun.RUNNING,
			failure = null,
			SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE)),
		),
		SpawnContainer(
			"godot-game",
			ContainerRun.STOPPED,
			failure = "devcontainer up exited 1: port 5432 is taken",
			SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE)),
		),
		SpawnContainer("nyaakube", ContainerRun.RUNNING, failure = null, SpawnHarnesses.UNOPENED_CONTAINER),
	)
	1 -> listOf(SpawnContainer("recipe-app", ContainerRun.STOPPED, failure = null, SpawnHarnesses.UNOPENED_CONTAINER))
	else -> emptyList()
}

////////////////////////////////
//  Classes

/** Answers Start, Stop and Create as a Gateway would: queued first, the state after. */
internal class SandboxContainerGateway(
	private val state: MutableStateFlow<ChatState>,
	private val later: (suspend () -> Unit) -> Unit,
) : ContainerGateway {
	override suspend fun start(target: String, opId: String) {
		delay(CONTAINER_ROUND_TRIP_MS)
		val point = spawnPointOf(target)
		move(point) { it.copy(run = ContainerRun.STARTING, failure = null) }
		later {
			delay(CONTAINER_BUILD_MS)
			// A Stop meanwhile wins.
			move(point) { if (it.run == ContainerRun.STARTING) it.copy(run = ContainerRun.RUNNING) else it }
		}
	}

	override suspend fun stop(target: String, opId: String) {
		delay(CONTAINER_ROUND_TRIP_MS)
		move(spawnPointOf(target)) { it.copy(run = ContainerRun.STOPPED, failure = null) }
	}

	/** Answers at once, then settles. */
	suspend fun create(target: String, sessionName: String?, displayLabel: String?, harness: String): ConsoleCreateSessionResult {
		delay(CONTAINER_ROUND_TRIP_MS)
		val point = spawnPointOf(target)
		val id = sessionName ?: "s${System.currentTimeMillis().toString(36).takeLast(5)}"
		val address = Address.of(point.domain, point.gateway, point.spawn, id).canonical
		fun row(status: String, working: Boolean?) = Team(
			name = address,
			presence = Presence.reported(
				TeamInfo(
					team = address,
					gatewayId = point.gateway,
					domainId = point.domain,
					status = status,
					kind = "loose",
					queue_depth = 0,
					working = working,
				),
				Authority.LIVE,
			),
			sessionLabel = displayLabel,
			harness = readHarness(harness),
		)
		state.update { s -> s.copy(teams = s.teams.filterNot { it.name == address } + row(Presence.AVAILABLE, working = true)) }
		// A Copilot create never comes up, so the failed launch's dock is reachable.
		val fails = (readHarness(harness) as? HarnessWord.Named)?.harness == SessionHarness.COPILOT
		later {
			delay(SESSION_START_MS)
			val settled = if (fails) row(Presence.AVAILABLE, working = null) else row(Presence.ONLINE, working = null)
			state.update { s -> s.copy(teams = s.teams.filterNot { it.name == address } + settled) }
			if (fails) state.holdLaunchError(address, LaunchError(SANDBOX_LAUNCH_FAILURE, System.currentTimeMillis()))
		}
		return ConsoleCreateSessionResult(created = true, id = id, sessionLabel = displayLabel, status = "pending")
	}

	private fun spawnPointOf(target: String): SpawnPoint =
		parseQualifiedTarget(target) as? SpawnPoint ?: error("\"$target\" names a session, not a spawn point")

	private fun move(point: SpawnPoint, change: (SpawnContainer) -> SpawnContainer) {
		state.update { s ->
			s.copy(
				gateways = s.gateways.withEntry(point.gateway) { entry ->
					entry.copy(containers = entry.containers?.map { if (it.project == point.spawn) change(it) else it })
				},
			)
		}
	}
}
