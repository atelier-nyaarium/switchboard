package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.valueResultAadKind
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustOpsTest {
	private val world = FixtureWorld.fromResources()

	private fun sealedAnswer(op: OwnerOp, result: String): JsonElement {
		val aad = Crypto.ContentAad(world.domainId, world.ownerIdentity.sign.pub, 1, valueResultAadKind(op.opId))
		val envelope = Crypto.sealContent(result.toByteArray(Charsets.UTF_8), world.contentKey, aad)
		return buildJsonObject {
			put("outcome", "accepted")
			put("result", wireJson.encodeToJsonElement(ContentEnvelope.serializer(), envelope))
		}
	}

	private class Fake(var reachable: Boolean = true, var revokes: Boolean = true) : TrustOpsCollaborators {
		val log: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())
		var reachHold: TestHold? = null
		override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String) = dstDomainId == "friend-domain"
		override suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean {
			log += "revoke:$dstDomainId"
			return revokes
		}
		override suspend fun routerReachable(): Boolean {
			reachHold?.pass()
			return reachable
		}
	}

	private fun identity() = TestIdentityPort(testStore().also { it.saveOwnerIdentity(world.ownerIdentity) }, world.bootstrap())

	private fun ops(
		case: String,
		state: MutableStateFlow<ChatState>,
		fake: Fake,
		identity: TestIdentityPort = identity(),
		provision: ProvisionFence = ProvisionFence(),
		answer: (OwnerOp) -> String?,
	): TrustOps {
		val client = world.client(FixtureDraws.forCase("TrustOps", case), sender = { op ->
			val kind = op.op["kind"]?.jsonPrimitive?.content
			fake.log += "$kind:${op.op["gatewayId"]?.jsonPrimitive?.content ?: "-"}"
			// A Router-answered owner op comes back in the clear; a Gateway's answer comes back sealed.
			answer(op)?.let { if (kind?.startsWith("cross_domain_") == true) wireJson.parseToJsonElement(it) else sealedAnswer(op, it) }
		})
		return TrustOps(
			state,
			object : ClientPort {
				override fun client() = client
				override fun transport(): ConsoleRouterTransport = error("unused")
			},
			identity,
			IdlePresencePort,
			fake,
			provision,
		)
	}

	private fun peer(domainId: String, owner: String) = CrossDomainPeerEntry(domainId = domainId, gatewayId = "$domainId-gw", ownerSignPub = owner)

	@Test
	fun theAssistantIsNeverOfferedForSharing() {
		val assistant = Team("${world.domainId}.gw.host.assistant", Presence.ended(), role = ASSISTANT_ROLE)
		val worker = Team("${world.domainId}.gw.app.dev", Presence.ended())
		val state = MutableStateFlow(ChatState(teams = listOf(assistant, worker), gateways = testRegistry("gw")))

		val offered = ops("share-picker", state, Fake()) { null }.shareableSessions()

		assertEquals(listOf(worker.name), offered.map { it.name })
	}

	@Test
	fun receiverConfirmsWithThePolledPinUntilTrustStateClears() = runBlocking {
		val answers = ArrayDeque(
			listOf(
				"""{"listeningToken":"token","receiverOwnerSignPub":"owner","receiverGatewaySignPub":"gs","receiverGatewayBoxPub":"gb","receiverDomainId":"domain","receiverGatewayId":"gw-a","expiresAt":10}""",
				"""{"pairingArrived":true,"pin":"pin","sas":"123456","friendOwnerSignPub":"friend-owner","friendGatewaySignPub":"fs","friendGatewayBoxPub":"fb","friendDomainId":"friend-domain","friendGatewayId":"friend-gw"}""",
				"""{"ok":true}""",
			),
		)
		val fake = Fake()
		val ops = ops("receiver", MutableStateFlow(ChatState()), fake) { answers.removeFirst() }

		ops.crossDomainListen("gw-a").getOrThrow()
		val friend = ops.crossDomainListenState().getOrThrow() ?: error("pairing did not arrive")
		val confirmed = ops.crossDomainConfirmReceiver(friend).getOrThrow()
		ops.clearInMemory()
		val afterClear = ops.crossDomainConfirmReceiver(friend)

		assertEquals("friend-domain", friend.friendDomainId)
		assertEquals(ConfirmOutcome.Linked, confirmed)
		assertTrue(ops.isOwnerTrusted("friend-owner"))
		assertTrue(afterClear.isFailure)
		assertTrue(answers.isEmpty())
		assertEquals(listOf("gateway_value:gw-a", "gateway_value:gw-a", "gateway_value:gw-a"), fake.log)
	}

	@Test
	fun aRequesterPairingHoldsItsGatewayAndItsNonceAcrossConfirms() = runBlocking {
		val answers = ArrayDeque(
			listOf(
				"""{"sas":"654321","requesterOwnerSignPub":"me","receiverOwnerSignPub":"friend-owner","receiverDomainId":"friend-domain","receiverGatewayId":"friend-gw","receiverGatewaySignPub":"fs","receiverGatewayBoxPub":"fb"}""",
				"""{"ok":true}""",
				"""{"ok":true}""",
			),
		)
		val fake = Fake()
		val ops = ops("requester", MutableStateFlow(ChatState()), fake) { answers.removeFirst() }

		val pairing = ops.crossDomainRequest("gw-b", "friend-gw.token").getOrThrow()
		val held = ops.pairing() ?: error("no pairing held")
		assertEquals(ConfirmOutcome.Linked, ops.crossDomainConfirmRequester(pairing).getOrThrow())
		assertEquals(ConfirmOutcome.Linked, ops.crossDomainConfirmRequester(pairing).getOrThrow())

		assertEquals("gw-b", held.gatewayId)
		assertEquals(LinkRole.REQUESTER, held.role)
		assertTrue(held.linkNonce.isNotEmpty())
		assertEquals(held, ops.pairing())
		assertEquals(listOf("gateway_value:gw-b", "gateway_value:gw-b", "gateway_value:gw-b"), fake.log)
		ops.crossDomainCancel()
		assertEquals(null, ops.pairing())
		assertEquals("gateway_value:gw-b", fake.log.last())
	}

	@Test
	fun peersLandPerGatewayAndAGatewayThatCannotBeReadKeepsWhatItHad() = runBlocking {
		val stale = listOf(peer("old-domain", "old-owner"))
		val registry = testRegistry("gw-a", "gw-b").withEntry("gw-b") { it.copy(peers = GatewayList.Listed(stale)) }
		val state = MutableStateFlow(ChatState(gateways = registry))
		val fake = Fake()
		val ops = ops("peers", state, fake) { op ->
			if (op.op["gatewayId"]?.jsonPrimitive?.content == "gw-a") {
				"""{"peers":[{"domainId":"friend-domain","gatewayId":"friend-gw","ownerSignPub":"friend-owner"}]}"""
			} else {
				null
			}
		}

		ops.refreshPeers()

		assertEquals(listOf(peer("friend-domain", "friend-owner").copy(gatewayId = "friend-gw")), state.value.gateways.entry("gw-a")?.peers?.listedRows())
		assertEquals(stale, state.value.gateways.entry("gw-b")?.peers?.listedRows())
		assertEquals(mapOf("friend-domain" to "friend-owner", "old-domain" to "old-owner"), state.value.linkedPeerOwners)
	}

	@Test
	fun aFriendDomainsSessionsGoOnlyOnceEveryGatewayAnsweredWithoutIt() {
		val sessions = mapOf(
			"friend-domain" to com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry(
				"friend-domain", null, com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceVersion(1L, 1L), emptyList(), 0L,
			),
		)
		val cold = ChatState(gateways = testRegistry("gw-a", "gw-b"), crossDomainPeerSessions = sessions)
		val oneListed = cold.copy(gateways = cold.gateways.withEntry("gw-a") { it.copy(peers = GatewayList.Listed(emptyList())) })
		val bothListed = oneListed.copy(gateways = oneListed.gateways.withEntry("gw-b") { it.copy(peers = GatewayList.Listed(emptyList())) })

		assertEquals(sessions, peersLanded(cold).crossDomainPeerSessions)
		assertEquals(sessions, peersLanded(oneListed).crossDomainPeerSessions)
		assertEquals(emptyMap<String, Any>(), peersLanded(bothListed).crossDomainPeerSessions)
	}

	@Test
	fun aSessionSharesToADomainOnlyWhenItsOwnGatewayPairsWithIt() = runBlocking {
		val registry = testRegistry("gw-a", "gw-b").withEntry("gw-a") { it.copy(peers = GatewayList.Listed(listOf(peer("friend-domain", "friend-owner")))) }
		val ops = ops("shareable", MutableStateFlow(ChatState(gateways = registry)), Fake()) { null }
		val onA = testTeam("${world.domainId}.gw-a.app.dev")
		val onB = testTeam("${world.domainId}.gw-b.app.dev")

		assertTrue(ops.canShareTo(onA, "friend-domain"))
		assertFalse(ops.canShareTo(onA, "other-domain"))
		assertTrue(ops.canShareTo(onB, "other-domain"))
		assertFalse(ops.canShareTo(testTeam("${world.domainId}.gone-gw.app.dev"), "friend-domain"))
		val answers = listOf(GatewayList.Unread, GatewayList.Unreachable, GatewayList.NotServed, GatewayList.Listed(emptyList<CrossDomainPeerEntry>()))
		val shareable = answers.map { peers ->
			val held = testRegistry("gw-a").withEntry("gw-a") { it.copy(peers = peers) }
			ops("table", MutableStateFlow(ChatState(gateways = held)), Fake()) { null }.canShareTo(onA, "friend-domain")
		}
		assertEquals(listOf(true, true, true, false), shareable)
	}

	@Test
	fun aModeChangeDropsWhatItSupersedesBeforeItAddsAndPrivateDropsBoth() = runBlocking {
		val fake = Fake()
		val ops = ops("mode", MutableStateFlow(ChatState()), fake) { """{"ok":true}""" }
		val session = "${world.domainId}.gw-a.app.dev"

		ops.setShareMode(session, ShareAudience(false, setOf("b", "c")), ShareMode.EVERYONE).getOrThrow()
		ops.setShareMode(session, ShareAudience(true, emptySet()), ShareMode.SPECIFIC).getOrThrow()
		ops.setShareMode(session, ShareAudience(true, setOf("b")), ShareMode.PRIVATE).getOrThrow()

		assertEquals(
			listOf(
				"cross_domain_unshare:-", "cross_domain_unshare:-", "cross_domain_share:-",
				"cross_domain_unshare:-",
				"cross_domain_unshare:-", "cross_domain_unshare:-",
			),
			fake.log,
		)
	}

	@Test
	fun untrustStaysPendingWhileAGatewayCouldNotBeReadThisRound() = runBlocking {
		val fake = Fake()
		val identity = identity().also { it.federation.addTrustedOwner("friend-owner") }
		val registry = testRegistry("gw-a", "gw-b").withEntry("gw-b") { it.copy(peers = GatewayList.Listed(emptyList())) }
		val answers = untrustAnswers(mapOf("gw-a" to peerJson("friend-domain", "friend-owner")))
		val ops = ops("untrust-unread", MutableStateFlow(ChatState(gateways = registry)), fake, identity) { op ->
			if (op.op["gatewayId"]?.jsonPrimitive?.content == "gw-b") null else answers(op)
		}

		assertTrue(ops.untrustOwner("friend-owner").isSuccess)
		assertFalse(ops.isOwnerTrusted("friend-owner"))
		assertEquals(setOf("friend-owner"), ops.pendingUntrust.value)
		assertEquals(listOf("revoke:friend-domain"), fake.log.filter { it.startsWith("revoke:") })
	}

	@Test
	fun anUntrustWhoseRevokesLandedDropsTheFriendWhileAGatewayIsUnread() = runBlocking {
		val sessions = mapOf(
			"friend-domain" to com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry(
				"friend-domain", null, com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceVersion(1L, 1L), emptyList(), 0L,
			),
		)
		suspend fun untrusted(revokes: Boolean): Pair<Set<String>, Set<String>> {
			val state = MutableStateFlow(
				ChatState(
					gateways = testRegistry("gw-a", "gw-b"),
					linkedPeerOwners = mapOf("friend-domain" to "friend-owner"),
					crossDomainPeerSessions = sessions,
				),
			)
			val identity = identity().also { it.federation.addTrustedOwner("friend-owner") }
			val answers = untrustAnswers(mapOf("gw-a" to peerJson("friend-domain", "friend-owner")))
			val ops = ops("untrust-drops-$revokes", state, Fake(revokes = revokes), identity) { op ->
				if (op.op["gatewayId"]?.jsonPrimitive?.content == "gw-b") null else answers(op)
			}
			ops.untrustOwner("friend-owner")
			return state.value.linkedPeerOwners.keys to state.value.crossDomainPeerSessions.keys
		}

		assertEquals(emptySet<String>() to emptySet<String>(), untrusted(true))
		assertEquals(setOf("friend-domain") to setOf("friend-domain"), untrusted(false))
	}

	private fun untrustAnswers(peersOf: Map<String, String>): (OwnerOp) -> String? {
		val asked = java.util.Collections.synchronizedSet(mutableSetOf<String>())
		return { op ->
			val gatewayId = op.op["gatewayId"]?.jsonPrimitive?.content
			when {
				gatewayId == null -> null
				asked.add(gatewayId) -> """{"peers":[${peersOf[gatewayId].orEmpty()}]}"""
				else -> """{"peersRemoved":1,"sharesDropped":0,"jobsExpired":0}"""
			}
		}
	}

	@Test
	fun linkedDomainsComeFromEachGatewaysLastAnswerAndSharedSessionsAreCountedByOwner() {
		val read = GatewayList.Listed(listOf(peer("friend-domain", "friend-owner"), peer("second-domain", "friend-owner")))
		val unlinked = GatewayList.Listed(listOf(peer("friend-domain", "friend-owner")))

		// Unread Gateway blocks nothing.
		assertEquals(mapOf("friend-domain" to "friend-owner"), linkedOwners(listOf(unlinked, GatewayList.Unread)))
		assertEquals(
			mapOf("friend-domain" to "friend-owner", "second-domain" to "friend-owner"),
			linkedOwners(listOf(read, GatewayList.Unreachable)),
		)
		val disputed = GatewayList.Listed(listOf(peer("friend-domain", "other-owner")))
		assertEquals(mapOf("second-domain" to "friend-owner"), linkedOwners(listOf(read, disputed)))

		val counts = sharedCountsOf(
			linkedOwners = mapOf("friend-domain" to "friend-owner", "second-domain" to "friend-owner", "quiet-domain" to "quiet-owner"),
			specific = listOf("a" to "friend-domain", "d" to "second-domain", "a" to "second-domain", "a" to "elsewhere"),
			everyone = setOf("b", "c"),
		)
		// One owner's Domains count together.
		assertEquals(mapOf("friend-owner" to 4, "quiet-owner" to 2), counts)
	}

	@Test
	fun aGatewayThatRestartsKeepsItsLastPeersUntilItAnswersAgain() {
		val peers = GatewayList.Listed(listOf(peer("friend-domain", "friend-owner")))
		val held = testRegistry("gw-a").withEntry("gw-a") { it.copy(peers = peers, policies = GatewayList.Listed(emptyList())) }
		val restarted = com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection(
			plane = com.atelier_nyaarium.switchboard.proto.PresencePlane(epoch = 1, version = 2),
			owner = com.atelier_nyaarium.switchboard.proto.OwnerFacts("d", null, false),
			rows = emptyList(),
			linked = emptyList(),
			roster = listOf(com.atelier_nyaarium.switchboard.proto.RosterEntry("gw-a", true, 2, 2)),
			coverage = com.atelier_nyaarium.switchboard.proto.DiscoverCoverage(rosterKnown = true, asked = 1, answered = 1),
			spawnPoints = emptyList(),
		)

		val entry = held.landed(restarted, RegistryProvenance.Current) { null }.entry("gw-a")

		assertEquals(peers, entry?.peers)
		assertEquals(GatewayList.Unread, entry?.policies)
	}

	private fun peerJson(domainId: String, owner: String) = """{"domainId":"$domainId","gatewayId":"$domainId-gw","ownerSignPub":"$owner"}"""

	@Test
	fun untrustRevokesEveryEdgeBeforeItTellsTheGatewaysAndWaitsWhileTheRouterIsAway() = runBlocking {
		val fake = Fake(reachable = false)
		val identity = identity().also { it.federation.addTrustedOwner("friend-owner") }
		val peersOf = mapOf(
			"gw-a" to peerJson("friend-domain", "friend-owner"),
			"gw-b" to "${peerJson("friend-domain", "friend-owner")},${peerJson("second-domain", "friend-owner")}",
		)
		val ops = ops("untrust", MutableStateFlow(ChatState(gateways = testRegistry("gw-a", "gw-b"))), fake, identity, answer = untrustAnswers(peersOf))

		val away = ops.untrustOwner("friend-owner")
		assertTrue(away.isFailure)
		assertEquals(setOf("friend-owner"), ops.pendingUntrust.value)
		assertEquals(setOf("friend-owner"), identity.federation.pendingUntrust())
		assertTrue(ops.isOwnerTrusted("friend-owner"))
		assertEquals(emptyList<String>(), fake.log)

		fake.reachable = true
		ops.retryPendingUntrust()
		assertEquals(emptySet<String>(), ops.pendingUntrust.value)
		assertFalse(ops.isOwnerTrusted("friend-owner"))
		val revokes = fake.log.filter { it.startsWith("revoke:") }
		assertEquals(setOf("revoke:friend-domain", "revoke:second-domain"), revokes.toSet())
		val valueOps = fake.log.withIndex().filter { it.value.startsWith("gateway_value:") }.map { it.index }
		assertTrue(fake.log.indexOfLast { it.startsWith("revoke:") } < valueOps[2])
		assertEquals(setOf("gateway_value:gw-a", "gateway_value:gw-b"), listOf(fake.log[valueOps[2]], fake.log[valueOps[3]]).toSet())
	}

	@Test
	fun anUntrustStillOutAtAReprovisionMarksNothingForTheNextOwner() = runBlocking {
		val fake = Fake(reachable = false)
		val hold = TestHold().also { fake.reachHold = it }
		val identity = identity().also { it.federation.addTrustedOwner("friend-owner") }
		val provision = ProvisionFence()
		val ops = ops("untrust", MutableStateFlow(ChatState(gateways = testRegistry("gw-a"))), fake, identity, provision) { null }

		val out = async { ops.untrustOwner("friend-owner") }
		hold.entered.await()
		provision.reprovision { ops.clearInMemory() }
		hold.release()

		assertTrue(out.await().isFailure)
		assertEquals(emptySet<String>(), identity.federation.pendingUntrust())
	}

	@Test
	fun aRevocationTheRouterDoesNotTakeKeepsTheOwnerTrustedAndPending() = runBlocking {
		val fake = Fake(revokes = false)
		val identity = identity().also { it.federation.addTrustedOwner("friend-owner") }
		val ops = ops("untrust-refused", MutableStateFlow(ChatState(gateways = testRegistry("gw-a"))), fake, identity, answer = untrustAnswers(mapOf("gw-a" to peerJson("friend-domain", "friend-owner"))))

		assertTrue(ops.untrustOwner("friend-owner").isFailure)
		assertTrue(ops.isOwnerTrusted("friend-owner"))
		assertEquals(setOf("friend-owner"), ops.pendingUntrust.value)
		assertEquals(listOf("gateway_value:gw-a", "revoke:friend-domain"), fake.log)
	}
}
