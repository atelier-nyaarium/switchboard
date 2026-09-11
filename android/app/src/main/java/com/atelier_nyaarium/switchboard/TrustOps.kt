package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

private inline fun <T> Result<T>.mapFailure(transform: (Throwable) -> Throwable): Result<T> =
	fold({ Result.success(it) }, { Result.failure(transform(it)) })

/** One pairing at a time, on the Gateway the owner picked; gone with the process. */
internal data class Pairing(
	val gatewayId: String,
	val role: LinkRole,
	/** Retry-stable nonce. */
	val linkNonce: String,
	val listeningToken: String? = null,
	val pin: String? = null,
)

internal enum class ShareMode {
	PRIVATE,
	EVERYONE,
	SPECIFIC,
}

/** One session's audience as the Router holds it. */
internal data class ShareAudience(val everyone: Boolean, val domains: Set<String>) {
	val mode: ShareMode
		get() = when {
			everyone -> ShareMode.EVERYONE
			domains.isNotEmpty() -> ShareMode.SPECIFIC
			else -> ShareMode.PRIVATE
		}
}

internal interface TrustOpsCollaborators {
	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String): Boolean
	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean
	/** Nothing claims a revocation without it. */
	suspend fun routerReachable(): Boolean
}

internal class TrustOps(
	private val state: MutableStateFlow<ChatState>,
	private val clientPort: ClientPort,
	private val identity: IdentityPort,
	private val presence: PresencePort,
	private val collaborators: TrustOpsCollaborators,
) : ClearsOnReprovision {
	private var pairing: Pairing? = null
	private val reads = GatewayReadFence()
	private val _pendingUntrust = MutableStateFlow(identity.federation.pendingUntrust())
	/** Owners whose untrust has not landed everywhere; on disk, retried on welcome. */
	val pendingUntrust: StateFlow<Set<String>> = _pendingUntrust.asStateFlow()

	fun pairing(): Pairing? = pairing

	override suspend fun clearInMemory() {
		pairing = null
	}

	private fun markPending(owner: String, pending: Boolean) {
		identity.federation.markUntrustPending(owner, pending)
		_pendingUntrust.value = identity.federation.pendingUntrust()
	}

	/** Fetch the signed-proof-scoped cross-tenant roster. */
	suspend fun fetchRoster(): Result<List<com.atelier_nyaarium.switchboard.proto.RosterMember>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val result = clientPort.client().roster(identity.federation.signRosterRequest(System.currentTimeMillis()))
				if (!result.ok) error(result.error ?: "roster unavailable")
				result.members ?: emptyList()
			}
		}

	/** Linked peers remain visible when gateways are offline. */
	fun linkedDomains(): List<LinkedDomain> {
		val adminDomain = identity.readyOrNull()?.domainId ?: return emptyList()
		val s = state.value
		return CrossDomainLink.mergeLinkedDomains(s.teams, s.linkedPeerOwners, adminDomain, s.friendLabels())
	}

	/** Every session on a Gateway the roster names; a session whose Gateway is gone shares nothing. */
	fun shareableSessions(): List<Team> {
		val adminDomain = identity.readyOrNull()?.domainId ?: return emptyList()
		val s = state.value
		return s.teams
			.filter { it.domainId == adminDomain && s.gateways.has(it.gatewayId) }
			.filter { it.kind == "devcontainer" || it.kind == "loose" }
			.sortedBy { s.label(it.name) }
	}

	suspend fun crossDomainListen(gatewayId: String): Result<com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable { clientPort.client().crossDomainListen(gatewayId) }.onSuccess {
			pairing = Pairing(gatewayId, LinkRole.RECEIVER, freshLinkNonce(), it.listeningToken)
		}
		}

	/** Open a requester pairing and run the commit-reveal exchange. */
	suspend fun crossDomainRequest(gatewayId: String, listeningToken: String): Result<CrossDomainPairing> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val pin = newRendezvousPin()
				val boot = identity.readyOrNull() ?: error("Domain not yet confirmed by a local session")
				val adminDomain = boot.domainId
				pairing = Pairing(gatewayId, LinkRole.REQUESTER, freshLinkNonce(), pin = pin)
				val result = clientPort.client().crossDomainRequest(
					gatewayId = gatewayId,
					listeningToken = listeningToken.trim(),
					pin = pin,
					requesterOwnerSignPub = boot.ownerSignPub,
					requesterDomainId = adminDomain,
				)
				CrossDomainPairing(pin = pin, result = result)
			}
		}

	suspend fun crossDomainListenState(): Result<CrossDomainReceiverPairing?> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val held = pairing?.takeIf { it.role == LinkRole.RECEIVER }
					?: error("no receiver pairing is held")
				val state = clientPort.client().crossDomainListenState(held.gatewayId, held.listeningToken ?: error("no listening token"))
				if (!state.pairingArrived) {
					return@runCatchingCancellable null
				}
				// Pairing readiness requires every signed-link input.
				CrossDomainReceiverPairing(
					sas = state.sas ?: error("pairing arrived without a SAS"),
					friendOwnerSignPub = state.friendOwnerSignPub ?: error("pairing arrived without the friend owner key"),
					friendDomainId = state.friendDomainId ?: error("pairing arrived without the friend Domain id"),
					friendGatewayId = state.friendGatewayId ?: error("pairing arrived without the friend Gateway id"),
					friendGatewaySignPub = state.friendGatewaySignPub ?: error("pairing arrived without the friend sign key"),
					friendGatewayBoxPub = state.friendGatewayBoxPub ?: error("pairing arrived without the friend box key"),
				).also { pairing = held.copy(pin = state.pin ?: error("pairing arrived without the pin")) }
			}
		}

	suspend fun crossDomainConfirmRequester(pairing: CrossDomainPairing): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			val held = this@TrustOps.pairing?.takeIf { it.role == LinkRole.REQUESTER }
				?: return@withContext Result.failure(IllegalStateException("no requester pairing is held"))
			val r = pairing.result
			confirmWithMyLink(
				pin = pairing.pin,
				peerOwnerSignPub = r.receiverOwnerSignPub,
				peerDomainId = r.receiverDomainId,
				peerGatewayId = r.receiverGatewayId,
				peerSignPub = r.receiverGatewaySignPub,
				peerBoxPub = r.receiverGatewayBoxPub,
				gatewayId = held.gatewayId,
				linkNonce = held.linkNonce,
			)
		}

	suspend fun crossDomainConfirmReceiver(
		friend: CrossDomainReceiverPairing,
	): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		val held = pairing?.takeIf { it.role == LinkRole.RECEIVER }
			?: return@withContext Result.failure(IllegalStateException("no receiver pairing is held"))
		val pin = held.pin ?: return@withContext Result.failure(
			IllegalStateException("no pairing pin for this listening window; poll the link state first"),
		)
		confirmWithMyLink(
			pin = pin,
			peerOwnerSignPub = friend.friendOwnerSignPub,
			peerDomainId = friend.friendDomainId,
			peerGatewayId = friend.friendGatewayId,
			peerSignPub = friend.friendGatewaySignPub,
			peerBoxPub = friend.friendGatewayBoxPub,
			gatewayId = held.gatewayId,
			linkNonce = held.linkNonce,
		)
	}

	/** Commit local trust before the relay-affinity edge. */
	private suspend fun confirmWithMyLink(
		gatewayId: String,
		pin: String,
		peerOwnerSignPub: String,
		peerDomainId: String,
		peerGatewayId: String,
		peerSignPub: String,
		peerBoxPub: String,
		linkNonce: String,
	): Result<ConfirmOutcome> = runCatchingCancellable {
		val mySignedLink = identity.federation.signMyLink(
			peerOwnerSignPub = peerOwnerSignPub,
			peerDomainId = peerDomainId,
			peerGatewayId = peerGatewayId,
			peerSignPub = peerSignPub,
			peerBoxPub = peerBoxPub,
			nowMs = System.currentTimeMillis(),
			nonce = linkNonce,
		)
		// Refusal keeps pairing open.
		clientPort.client().crossDomainConfirm(gatewayId, pin, mySignedLink)
		identity.federation.addTrustedOwner(peerOwnerSignPub)
		// Surface relay-edge rejection separately from local linking.
		if (collaborators.submitXdomainLink(identity.ready().domainId, peerDomainId)) {
			ConfirmOutcome.Linked
		} else {
			ConfirmOutcome.RelayEdgeRejected(peerDomainId)
		}
	}

	suspend fun retryXdomainLinkEdge(peerDomainId: String): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			if (collaborators.submitXdomainLink(identity.ready().domainId, peerDomainId)) {
				ConfirmOutcome.Linked
			} else {
				ConfirmOutcome.RelayEdgeRejected(peerDomainId)
			}
		}
	}

	fun freshLinkNonce(): String = identity.federation.freshLinkNonce()

	suspend fun crossDomainCancel() = withContext(Dispatchers.IO) {
		val held = pairing
		pairing = null
		if (held == null) return@withContext Result.success(Unit)
		runCatchingCancellable {
			clientPort.client().crossDomainCancel(held.gatewayId, held.listeningToken, held.pin)
			Unit
		}
	}

	fun isOwnerTrusted(ownerSignPub: String): Boolean = identity.federation.isTrusted(ownerSignPub)

	fun trustedOwners(): Set<String> = identity.federation.trustedOwners()

	/**
	 * The Router edges go first, and local trust goes only once every one of them has; a Gateway that
	 * could not be told, or whose peers were never read, keeps the owner pending for the next welcome.
	 */
	suspend fun untrustOwner(peerOwnerSignPub: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			if (!collaborators.routerReachable()) {
				markPending(peerOwnerSignPub, true)
				error("The Router cannot be reached; the untrust is pending")
			}
			val fresh = refreshPeers()
			val entries = state.value.gateways.gateways
			val peers = entries.flatMap { entry ->
				entry.peers.orEmpty().filter { it.ownerSignPub == peerOwnerSignPub }.map { peer -> entry.id to peer }
			}
			val revoked = peers.map { it.second.domainId }.toSet().all { domainId ->
				runCatchingCancellable { collaborators.revokeXdomainLink(identity.ready().domainId, domainId) }.getOrDefault(false)
			}
			if (!revoked) {
				markPending(peerOwnerSignPub, true)
				error("The Router did not take the revocation; the untrust is pending")
			}
			// A Gateway read this round and told is done; one read earlier may hold a pairing this round missed.
			val told = peers.map { it.first }.toSet().all { gatewayId ->
				runCatchingCancellable { clientPort.client().crossDomainUntrust(gatewayId, peerOwnerSignPub) }.isSuccess
			} && fresh.containsAll(entries.map { it.id })
			identity.federation.removeTrustedOwner(peerOwnerSignPub)
			markPending(peerOwnerSignPub, !told)
			refreshPeers()
			presence.refreshAfterAction()
			Unit
		}
	}

	/** Assign the symmetric SAS role by sorted owner key. */
	private fun trustRole(myOwner: String, peerOwner: String): String =
		if (myOwner < peerOwner) EnrollCeremony.ADMIN else EnrollCeremony.ENROLLEE

	fun mintRendezvousId(): String = identity.federation.freshRendezvousId()

	suspend fun fetchPendingTrust(): Result<List<com.atelier_nyaarium.switchboard.proto.TrustPendingEntry>> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val r = clientPort.client().trustPending(identity.federation.signTrustPendingRequest(System.currentTimeMillis()))
				if (!r.ok) error(r.error ?: "trust pending unavailable")
				r.pending ?: emptyList()
			}
		}

	suspend fun trustExchange(
		rendezvousId: String,
		mySide: String,
		peerOwnerSignPub: String,
	): Result<EnrollExchange> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val myParty = identity.federation.trustParty(identity.ready().domainId)
				runSasExchange(
					myParty = myParty,
					myRole = trustRole(myParty.ownerSignPub, peerOwnerSignPub),
					// The rendezvous ID is the SAS pin.
					pin = rendezvousId,
					salt = identity.federation.freshEnrollSalt(),
					// Recovery re-arms from the roster.
					retryHint = "Try again.",
					transport = object : SasTransport {
						override suspend fun commit(commitment: String): String? {
							val op = if (mySide == TRUST_SIDE_INITIATOR) {
								TrustHandshakeOp.Arm(rendezvousId, myParty.ownerSignPub, peerOwnerSignPub, commitment)
							} else {
								TrustHandshakeOp.Join(rendezvousId, myParty.ownerSignPub, commitment)
							}
							val r = clientPort.client().trustHandshake(op)
							if (!r.ok) error(r.error ?: "trust commit rejected")
							return r.peerCommitment
						}

						override suspend fun reveal(myReveal: com.atelier_nyaarium.switchboard.proto.EnrollReveal) =
							clientPort.client().trustHandshake(TrustHandshakeOp.Reveal(rendezvousId, mySide, myReveal)).let {
								if (!it.ok) error(it.error ?: "trust reveal rejected")
								it.peerReveal
							}
					},
					authenticatePeer = { EnrollCeremony.ownerMismatch(peerOwnerSignPub, it) },
				)
			}
		}

	suspend fun trustCancel(rendezvousId: String) = withContext(Dispatchers.IO) {
		runCatchingCancellable { clientPort.client().trustHandshake(TrustHandshakeOp.Cancel(rendezvousId)) }
	}

	data class HeldShares(val everyone: Set<String>, val specific: Set<Pair<String, String>>)

	suspend fun crossDomainShares(): Result<HeldShares> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			clientPort.client().crossDomainListShares().shares
				.fold(HeldShares(emptySet(), emptySet())) { held, e ->
					if (e.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted) held.copy(everyone = held.everyone + e.sessionTarget)
					else (e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						held.copy(specific = held.specific + (e.sessionTarget to it.domainId))
					} ?: held
				}
		}
	}

	suspend fun sharedSessionCounts(): Result<Map<String, Int>> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val shares = crossDomainShares().getOrThrow()
			state.value.linkedPeerOwners.mapValues { (_, domain) ->
				(shares.specific.filter { it.second == domain }.map { it.first }.toSet() + shares.everyone).size
			}
		}
	}

	suspend fun setCrossDomainShare(sessionTarget: String, domainId: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain(domainId)
				if (shared) clientPort.client().crossDomainShare(sessionTarget, target) else clientPort.client().crossDomainUnshare(sessionTarget, target)
				Unit
			}.mapFailure { if (it.message == "session") IllegalStateException("This Gateway has not reported the session yet") else it }
	}

	/** Never-read peers answer true; a Gateway the roster does not name answers false. */
	fun canShareTo(team: Team, domainId: String): Boolean = state.value.gateways.entry(team.gatewayId)?.let { entry ->
		entry.peers?.let { state.value.gateways.hasPeer(team.gatewayId, domainId) } ?: true
	} ?: false

	fun peersOn(gatewayId: String): List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry> = state.value.gateways.peersOn(gatewayId)

	/** Answers the Gateways whose read landed this round; the rest keep what they had. */
	suspend fun refreshPeers(): Set<String> = coroutineScope {
		val fresh = state.value.gateways.ids().map { gatewayId -> async {
			val read = runCatching { reads.read(gatewayId) { clientPort.client().crossDomainListPeers(gatewayId) } }.getOrNull()
			val answer = (read as? GatewayRead.Fresh)?.value ?: return@async null
			state.update { it.copy(gateways = it.gateways.withEntry(gatewayId) { e -> e.copy(peers = answer.peers) }) }
			gatewayId
		} }.awaitAll().filterNotNull().toSet()
		val all = state.value.gateways.gateways.flatMap { it.peers.orEmpty() }.filter { it.domainId.isNotEmpty() }
		val owners = all.groupBy { it.domainId }.mapNotNull { (domain, entries) ->
			val values = entries.map { it.ownerSignPub }.distinct()
			if (values.size == 1) domain to values.single() else {
				DebugLog.log("Trust", "conflicting peer owner for $domain")
				null
			}
		}.toMap()
		state.update { it.copy(linkedPeerOwners = owners, crossDomainPeerSessions = it.crossDomainPeerSessions.filterKeys { domain -> domain in owners }) }
		fresh
	}

	suspend fun retryPendingUntrust() {
		for (owner in pendingUntrust.value.toList()) untrustOwner(owner)
	}

	/** Everyone supersedes specific people, and Private drops both; Specific only drops Everyone, the picker adds people. */
	suspend fun setShareMode(sessionTarget: String, current: ShareAudience, mode: ShareMode): Result<Unit> = runCatchingCancellable {
		when (mode) {
			ShareMode.PRIVATE -> {
				if (current.everyone) setShareEveryoneTrusted(sessionTarget, false).getOrThrow()
				for (domainId in current.domains) setCrossDomainShare(sessionTarget, domainId, false).getOrThrow()
			}
			ShareMode.EVERYONE -> {
				for (domainId in current.domains) setCrossDomainShare(sessionTarget, domainId, false).getOrThrow()
				setShareEveryoneTrusted(sessionTarget, true).getOrThrow()
			}
			ShareMode.SPECIFIC -> {
				if (current.everyone) setShareEveryoneTrusted(sessionTarget, false).getOrThrow()
			}
		}
	}

	suspend fun setShareEveryoneTrusted(sessionTarget: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatchingCancellable {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted
				if (shared) clientPort.client().crossDomainShare(sessionTarget, target) else clientPort.client().crossDomainUnshare(sessionTarget, target)
				Unit
			}.mapFailure { if (it.message == "session") IllegalStateException("This Gateway has not reported the session yet") else it }
		}

	private fun newRendezvousPin(): String {
		val bytes = ByteArray(18)
		java.security.SecureRandom().nextBytes(bytes)
		return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
	}
}
