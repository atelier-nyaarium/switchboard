package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** What a pick of a spawn point means now. [note] sits beside its name. */
internal enum class SpawnReadiness(val note: String?, val enabled: Boolean) {
	READY(note = null, enabled = true),

	/** A create starts it. */
	STOPPED(note = "stopped", enabled = true),
	STARTING(note = "starting", enabled = true),
	NO_CLI(note = "no CLI", enabled = false),

	/** A newer state word. */
	UNREAD(note = null, enabled = false),
}

/** `spawn` is the bare segment a routine stores; `label` is what a menu shows. */
internal data class SpawnChoice(
	val spawn: String,
	val label: String,
	val offered: Boolean = true,
	val readiness: SpawnReadiness = SpawnReadiness.READY,
)

////////////////////////////////
//  Constants

internal val HOST_SPAWN_IDS = setOf("host", "windows")

////////////////////////////////
//  Functions & Helpers

internal fun hostSpawnLabel(id: String, offered: List<String>): String = when {
	id == "windows" -> "Windows"
	id == "host" && offered.contains("windows") -> "WSL"
	else -> id
}

/** Advertised spawns beyond `host`; nothing for a Gateway that projected none. */
internal fun hostSpawnChoices(hostSpawns: List<String>?): List<String> {
	if (hostSpawns == null) return emptyList()
	val detected = hostSpawns.filter { it in HOST_SPAWN_IDS && it != "host" }.distinct().sorted()
	return detected + "host"
}

/** [container] is null for a host shell. */
internal fun spawnReadiness(container: SpawnContainer?, harnesses: SpawnHarnesses): SpawnReadiness =
	when {
		container != null && container.run == null -> SpawnReadiness.UNREAD
		harnessesOf(harnesses).isEmpty() -> SpawnReadiness.NO_CLI
		container?.run == ContainerRun.STOPPED -> SpawnReadiness.STOPPED
		container?.run == ContainerRun.STARTING -> SpawnReadiness.STARTING
		else -> SpawnReadiness.READY
	}

/** Host spawns first, then this Gateway's devcontainers, a reported one with no sessions included. */
internal fun spawnChoices(state: ChatState, gatewayId: String): List<SpawnChoice> {
	val gateways = state.gateways
	val hosts = hostSpawnChoices(gateways.hostSpawns(gatewayId))
	val sessions = localSessions(state.sessions(), state.domainId.orEmpty()).filter { it.gatewayId == gatewayId }
	val containers = (sessions.filter { it.kind == "devcontainer" }.map { it.shortName } +
		gateways.containersOn(gatewayId).map { it.project }.sorted())
		.filterNot { it in HOST_SPAWN_IDS }
		.distinct()
	fun choice(spawn: String, label: String, container: SpawnContainer?) =
		SpawnChoice(spawn, label, readiness = spawnReadiness(container, gateways.harnessesOn(gatewayId, spawn)))
	return hosts.map { choice(it, hostSpawnLabel(it, hosts), container = null) } +
		containers.map { choice(it, it, gateways.container(gatewayId, it)) }
}

/** A held spawn the Gateway no longer offers stays pickable, first and marked. */
internal fun spawnMenu(choices: List<SpawnChoice>, held: String): List<SpawnChoice> =
	if (held.isBlank() || choices.any { it.spawn == held }) choices
	else listOf(SpawnChoice(held, held, offered = false)) + choices

/** A header's own Create picks its project, stopped or not; a remembered one only where it is up. */
internal fun initialChoice(openedOn: String?, remembered: String?, choices: List<SpawnChoice>): String? =
	openedOn?.takeIf { opened -> choices.any { it.spawn == opened && it.readiness.enabled } }
		?: remembered?.takeIf { held -> choices.any { it.spawn == held && it.readiness == SpawnReadiness.READY } }
