package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class PresenceOps(private val host: PresenceHost) : ClearsOnReprovision, ReadAnchorSync {
	private val projectionMutex = Mutex()
	private val readAnchorReportMutex = Mutex()
	private val readAnchorLock = Any()
	private val pendingReadAnchorLock = Any()
	private val pendingRemoteReadAnchors = mutableMapOf<String, ReadAnchor>()

	// Raw rows support recovery.
	@Volatile var lastRawTeams: List<Team>? = null

	@Volatile var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	override suspend fun clearInMemory() {
		lastRawTeams = null
		synchronized(pendingReadAnchorLock) { pendingRemoteReadAnchors.clear() }
		readAnchorReportMutex.withLock {
			synchronized(readAnchorLock) { lastReportedReadAnchors = emptyMap() }
		}
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
		val changed = synchronized(pendingReadAnchorLock) {
			entries.forEach { entry ->
				pendingRemoteReadAnchors[entry.stream] = ReadAnchor(entry.epoch, entry.seq, entry.at)
			}
			mergePendingReadAnchorsLocked(pendingRemoteReadAnchors.toMap())
		}
		if (changed) host.persistReadAnchors()
	}

	override fun retryPendingReadAnchor(stream: String) {
		val changed = synchronized(pendingReadAnchorLock) {
			val candidate = pendingRemoteReadAnchors[stream] ?: return@synchronized false
			mergePendingReadAnchorsLocked(mapOf(stream to candidate))
		}
		if (changed) host.persistReadAnchors()
	}

	private fun mergePendingReadAnchorsLocked(candidates: Map<String, ReadAnchor>): Boolean {
		if (candidates.isEmpty()) return false
		val before = host.state.value.readAnchors
		var folded: ChatState? = null
		host.state.update { state ->
			var next = state
			candidates.forEach { (stream, candidate) ->
				val current = next.readAnchors[stream]
				if (!isConversationStream(stream)) {
					val merged = mergeStreamAnchor(current, candidate)
					if (merged != current) next = next.copy(readAnchors = next.readAnchors + (stream to merged))
				} else {
					val thread = next.threads[stream].orEmpty()
					if (anchorIndex(thread, candidate) < 0) return@forEach
					val merged = mergeReadAnchor(thread, current, candidate)
					if (merged != null && merged != current) {
						next = next.copy(readAnchors = next.readAnchors + (stream to merged)).recomputeUnread(stream, thread)
					}
				}
			}
			folded = next
			next
		}
		val landed = folded ?: host.state.value
		val resolved = candidates.filter { (stream, candidate) ->
			!isConversationStream(stream) || anchorIndex(landed.threads[stream].orEmpty(), candidate) >= 0
		}
		resolved.keys.forEach { pendingRemoteReadAnchors.remove(it) }
		val reported = resolved.mapNotNull { (stream, candidate) ->
			landed.readAnchors[stream]?.takeIf { it.epoch == candidate.epoch && it.seq == candidate.seq }
				?.let { stream to it }
		}.toMap()
		if (reported.isNotEmpty()) synchronized(readAnchorLock) {
			lastReportedReadAnchors = lastReportedReadAnchors + reported
		}
		return before != landed.readAnchors
	}

	override suspend fun reportLocalReadAdvances() = readAnchorReportMutex.withLock {
		val anchors = host.state.value.readAnchors
		val reportedAtStart = synchronized(readAnchorLock) { lastReportedReadAnchors }
		for (stream in streamsNeedingReadReport(anchors, reportedAtStart)) {
			val anchor = anchors.getValue(stream)
			runCatchingCancellable { host.reportRead(stream, anchor) }
				.onSuccess {
					synchronized(readAnchorLock) {
						if (lastReportedReadAnchors[stream] == reportedAtStart[stream]) {
							lastReportedReadAnchors = lastReportedReadAnchors + (stream to anchor)
						}
					}
				}
				.onFailure { DebugLog.log("Plane", "report_read failed for $stream: ${it.message?.take(120)}") }
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
		val slot = runCatchingCancellable { host.loadRouterState("presence") }.getOrNull() ?: return@withLock
		val projection = runCatchingCancellable {
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
		runIsolated {
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
		applyPlanePresenceLocked(projection.rows.mapNotNull(::teamInfoToTeam), projection.owner.domainId)
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

	private val actionPulls = Mutex()

	private val actionPullWanted = AtomicBoolean(false)

	/** An action during a pull earns one more pull after it. */
	suspend fun refreshAfterAction() {
		actionPullWanted.set(true)
		while (actionPullWanted.get() && actionPulls.tryLock()) {
			try {
				while (actionPullWanted.getAndSet(false)) runCatchingCancellable { host.pullPlanes() }
			} finally {
				actionPulls.unlock()
			}
		}
	}

	suspend fun reapplyCachedTeams() {
		val raw = lastRawTeams ?: return
		freshTeamsMutex.withLock {
			val now = System.currentTimeMillis()
			val visible = filterTombstoned(raw, host.forgottenUntil, now).map(::foldReceipt)
			host.state.update { it.withFreshTeams(visible) }
			host.persistLabels()
			host.persistAbsenceStreaks()
			host.persistRoles()
		}
	}
}
