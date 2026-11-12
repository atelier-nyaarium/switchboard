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

private const val SANDBOX_LAUNCH_FAILURE = "Copilot is not installed."
private const val SANDBOX_CONTAINER_LACKS = "Devcontainer does not have Copilot. Choose another CLI."
private const val SANDBOX_START_FAILURE = "Devcontainer failed to start."

/** Gateway `index`'s containers, so each answers differently; the last reports none. */
internal fun sandboxContainers(index: Int): List<SpawnContainer> = when (index) {
	0 -> listOf(
		SpawnContainer(
			"recipe-app",
			ContainerRun.RUNNING,
			failure = null,
			SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE)),
		),
		// Its start fails again on a create.
		SpawnContainer(
			"godot-game",
			ContainerRun.STOPPED,
			failure = "devcontainer up exited 1: port 5432 is taken",
			SpawnHarnesses.UNOPENED_CONTAINER,
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
		fun settle(up: Boolean, failure: String?) {
			val settled = row(if (up) Presence.ONLINE else Presence.AVAILABLE, working = null)
			state.update { s -> s.copy(teams = s.teams.filterNot { it.name == address } + settled) }
			if (failure != null) state.holdLaunchError(address, LaunchError(failure, System.currentTimeMillis()))
		}
		// A create starts a container that is not up; one with a standing failure fails again.
		val container = state.value.gateways.container(point.gateway, point.spawn)
		val starts = container != null && container.run != ContainerRun.RUNNING
		val broken = container?.failure
		if (starts) move(point) { it.copy(run = ContainerRun.STARTING, failure = null) }
		// Copilot never comes up.
		val fails = (readHarness(harness) as? HarnessWord.Named)?.harness == SessionHarness.COPILOT
		later {
			if (starts) {
				delay(CONTAINER_BUILD_MS)
				if (broken != null) {
					move(point) { it.copy(run = ContainerRun.STOPPED, failure = broken) }
					settle(up = false, failure = SANDBOX_START_FAILURE)
					return@later
				}
				// A Stop meanwhile wins.
				move(point) { if (it.run == ContainerRun.STARTING) it.copy(run = ContainerRun.RUNNING) else it }
			}
			delay(SESSION_START_MS)
			val lacks = if (container == null) SANDBOX_LAUNCH_FAILURE else SANDBOX_CONTAINER_LACKS
			settle(up = !fails, failure = lacks.takeIf { fails })
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
