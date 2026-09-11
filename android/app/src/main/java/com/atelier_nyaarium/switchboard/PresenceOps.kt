package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class PresenceOps(private val host: PresenceHost) : ClearsOnReprovision {
	private val projectionMutex = Mutex()

	// Raw rows remain available for tombstone expiry recovery.
	@Volatile var lastRawTeams: List<Team>? = null

	@Volatile var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	override suspend fun clearInMemory() {
		lastRawTeams = null
		lastReportedReadAnchors = emptyMap()
		restoreMutex.withLock { restored = false }
	}

	/** Cached facts cannot overwrite names. */
	private fun applyOwnerFacts(stated: OwnerFacts, live: Boolean) {
		val name = if (live) stated.displayName.orEmpty() else host.storedDisplayName
		if (name != host.storedDisplayName) host.storedDisplayName = name
		val owner = stated.copy(displayName = name.ifEmpty { null })
		host.state.update { if (it.owner == owner) it else it.copy(owner = owner) }
	}

	suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		host.state.update { it.copy(crossDomainPeerSessions = it.crossDomainPeerSessions + entries.associateBy { e -> e.domainId }) }
	}

	fun applyReadAnchors(entries: List<com.atelier_nyaarium.switchboard.proto.ReadAnchorWireEntry>) {
		// Epochs are random tags; compare them only for equality.
		var anyChanged = false
		val next = host.state.updateAndGet { s ->
			var st = s
			for (e in entries) {
				val team = e.team
				val thread = st.threads[team].orEmpty()
				val candidate = ReadAnchor(e.epoch, e.seq, e.at)
				if (isAnchorAdvance(thread, st.readAnchors[team], candidate)) {
					anyChanged = true
					lastReportedReadAnchors = lastReportedReadAnchors + (team to candidate)
					st = st.copy(readAnchors = st.readAnchors + (team to candidate)).recomputeUnread(team, thread)
				}
			}
			st
		}
		if (anyChanged) host.persistReadAnchors(next.readAnchors)
	}

	suspend fun reportLocalReadAdvances() {
		val anchors = host.state.value.readAnchors
		for (team in teamsNeedingReadReport(anchors, lastReportedReadAnchors)) {
			val anchor = anchors.getValue(team)
			runCatching { host.reportRead(team, anchor) }
				.onSuccess { lastReportedReadAnchors = lastReportedReadAnchors + (team to anchor) }
				.onFailure { DebugLog.log("Plane", "report_read failed for $team: ${it.message?.take(120)}") }
		}
	}

	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		runCatchingCancellable { host.pullPlanes(everything = true) }
	}

	private val restoreMutex = Mutex()
	private var restored = false

	/** Once per provisioning; every caller may await it. */
	suspend fun restoreLastProjection() = restoreMutex.withLock {
		if (restored) return@withLock
		restored = true
		val slot = runCatching { host.loadRouterState("presence") }.getOrNull() ?: return@withLock
		val projection = runCatching {
			wireJson.decodeFromJsonElement(OwnerPresenceProjection.serializer(), slot.payload)
		}.getOrNull() ?: return@withLock
		host.withDrainMutex {
			projectionMutex.withLock {
				if (lastRawTeams != null) return@withLock
				landProjection(projection, live = false)
			}
		}
	}

	/** The cursor's fold has already decided; the slot follows the land. */
	suspend fun applyOwnerProjection(projection: OwnerPresenceProjection) = host.withDrainMutex { projectionMutex.withLock {
		landProjection(projection, live = true)
		runCatching {
			host.saveRouterState(
				"presence",
				RouterStateSlot(
					epoch = projection.plane.epoch,
					version = projection.plane.version,
					payload = wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), projection),
				),
			)
		}
	} }

	private suspend fun landProjection(projection: OwnerPresenceProjection, live: Boolean) {
		applyOwnerFacts(projection.owner, live)
		val provenance = if (live) RegistryProvenance.Current else RegistryProvenance.Cached
		host.state.update { it.copy(gateways = it.gateways.landed(projection, provenance, host::storedRunbooks)) }
		applyPlanePresenceLocked(projection.rows.map(::teamInfoToTeam), projection.owner.domainId)
		applyCrossDomainPresence(projection.linked)
	}

	private suspend fun applyPlanePresenceLocked(planeRows: List<Team>, planeDomain: String) {
		val fresh = planeRows.map { it.withAuthority(Authority.LIVE) }
		val merged = mergePresence(lastRawTeams ?: emptyList(), fresh) { row -> keepPriorRow(row, planeDomain) }
		applyPresenceLocked(merged)
	}

	private suspend fun applyPresenceLocked(fresh: List<Team>) {
		lastRawTeams = fresh
		reapplyCachedTeams()
	}

	private val freshTeamsMutex = Mutex()

	private fun foldReceipt(row: Team): Team {
		if (row.presence.isLive) {
			host.clearReceipt(row.name)
			return row.withReceipt(null)
		}
		return row.withReceipt(host.receiptFor(row.name, System.currentTimeMillis()))
	}

	private var lastActionPullAt = 0L
	private val ACTION_PULL_DEBOUNCE_MS = 2_000L

	suspend fun refreshAfterAction() {
		val now = System.currentTimeMillis()
		if (now - lastActionPullAt < ACTION_PULL_DEBOUNCE_MS) return
		lastActionPullAt = now
		runCatchingCancellable { host.pullPlanes() }
	}

	suspend fun reapplyCachedTeams() {
		val raw = lastRawTeams ?: return
		freshTeamsMutex.withLock {
			val now = System.currentTimeMillis()
			val visible = filterTombstoned(raw, host.forgottenUntil, now).map(::foldReceipt)
			val next = host.state.updateAndGet { it.withFreshTeams(visible) }
			host.persistLabels(next.labels)
			host.persistAbsenceStreaks(next.teamAbsenceStreaks)
		}
	}
}
