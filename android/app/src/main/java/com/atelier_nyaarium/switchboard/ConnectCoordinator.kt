package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface ConnectHost {
	val firstRooted: Boolean
	val consoleAdmitted: Boolean

	fun withoutTombstoned(teams: List<Team>): List<Team>

	suspend fun firstRootIfPending(): Boolean
	suspend fun submitConsoleAdmission()
	fun reportCapabilities()

	fun attachIngest()
	fun flushIngest()
}

internal class ConnectCoordinator(
	private val identity: PhoneIdentity,
	private val transport: () -> ConsoleReach,
	private val state: MutableStateFlow<ChatState>,
	private val host: ConnectHost,
) {
	suspend fun connect() {
		host.attachIngest()
		DebugLog.log("Connect", "start admitted=${host.consoleAdmitted}")
		// Fence learned facts to the starting provisioning blob.
		val blob = identity.blob() ?: return
		try {
			val reach = runCatchingCancellable { transport().apiReachable() }.getOrElse { e ->
				val (cause, kind) = classifyConnError(e)
				state.update {
					if (kind == ConnKind.TERMINAL) {
						it.copy(status = "error", error = "Cluster: $cause", connected = false, enrollingSince = 0L)
					} else {
						it.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
					}
				}
				return
			}
			DebugLog.log("Connect", "apiReachable ok")
			reach?.domainId?.let { identity.learnDomainId(it, blob) }
			// Root pending invites before submitting admission.
			if (!host.firstRootIfPending()) return
			if (host.firstRooted && !state.value.firstRooted) state.update { it.copy(firstRooted = true) }
			// Admission precedes sealed Gateway registration.
			runCatchingCancellable { host.submitConsoleAdmission() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				state.update {
					it.copy(
						status = if (kind == ConnKind.TERMINAL) "error" else "connecting",
						error = cause,
						connected = false,
						enrollingSince = 0L,
					)
				}
				return
			}
			host.reportCapabilities()
			val teams = state.value.teams
			state.update {
				it.copy(
					teams = host.withoutTombstoned(teams),
					status = "connected",
					error = null,
					connected = true,
					pollFailStreak = 0,
					enrollingSince = 0L,
				)
			}
			val boot = identity.readyOrNull()
			boot?.let(identity::ensureContentEpochs)
			DebugLog.log("Connect", "connected domain=${boot?.domainId ?: "none"}")
		} catch (e: Exception) {
			// Preserve coroutine cancellation semantics.
			e.rethrowIfCancellation()
			val (cause, kind) = classifyConnError(e)
			// Clear stale admission so enrollment can retry.
			if (kind == ConnKind.ENROLLING) identity.setConsoleAdmitted(false, blob)
			state.update { s ->
				when (kind) {
					ConnKind.ENROLLING -> {
						val (override, since) = enrollFold(s.enrollingSince)
						s.copy(
							status = if (override != null) "error" else "connecting",
							error = override ?: cause,
							connected = false,
							enrollingSince = since,
						)
					}
					ConnKind.TERMINAL -> s.copy(status = "error", error = cause, connected = false, enrollingSince = 0L)
					ConnKind.TRANSIENT -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
				}
			}
		} finally {
			host.flushIngest()
		}
	}
}

internal class ChatRepositoryConnectHost(private val repo: ChatRepository) : ConnectHost {
	override val firstRooted get() = repo.store.firstRooted
	override val consoleAdmitted get() = repo.store.consoleAdmitted

	override fun withoutTombstoned(teams: List<Team>) = with(repo) { teams.withoutTombstoned() }

	override suspend fun firstRootIfPending() = repo.ownerFacts.firstRootIfPending()
	override suspend fun submitConsoleAdmission() = repo.ownerFacts.submitConsoleAdmission()
	override fun reportCapabilities() {
		repo.pluginReportPending = false
		repo.repoScope.launch { repo.reportCapabilitiesToRouter() }
	}

	override fun attachIngest() {
		runCatching {
			repo.store.load()?.let { DebugLog.attachIngest(ConsoleCredentials.parse(it, repo.store)) { repo.client().transport.proxyBase } }
		}
	}

	override fun flushIngest() = DebugLog.flushToIngest()
}
