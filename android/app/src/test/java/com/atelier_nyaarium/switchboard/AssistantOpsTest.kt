package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleDraft
import com.atelier_nyaarium.switchboard.assistant.RuleEdit
import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.SaveOutcome
import com.atelier_nyaarium.switchboard.assistant.editorLanded
import com.atelier_nyaarium.switchboard.proto.AssistantActionDescriptor
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantFieldValue
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarried
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarriedWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantHomePutResult
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReadResult
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
import com.atelier_nyaarium.switchboard.proto.AssistantHomeSealed
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantUnexpectedValues
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherBackoff
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val UNCERTAIN = "durability_uncertain"

private fun watcher(
	grants: List<String> = listOf("gh-token"),
	unread: Long = 2L,
	capped: Boolean? = null,
	evicted: Long? = null,
	lastSuccessAt: Long? = null,
	backoff: AssistantWatcherBackoff? = null,
	stopped: String? = null,
	secret: String? = null,
) = AssistantWatcher(
	id = "github",
	label = "GitHub notifications",
	grants = grants,
	unread = unread,
	capped = capped,
	evicted = evicted,
	lastSuccessAt = lastSuccessAt,
	backoff = backoff,
	stopped = stopped,
	secret = secret,
)

class AssistantOpsTest {
	private data class SentPut(val baseVersion: Long, val gatewayId: String?, val sealed: ContentEnvelope?)
	private data class HomeSeal(val gatewayId: String, val version: Long, val sealed: AssistantHomeSealed)

	private class FakeHomeRouter(
		var current: AssistantHomeReadResult = AssistantHomeReadResult(),
	) : AssistantHomeRouter {
		val puts = mutableListOf<SentPut>()
		val seals = mutableListOf<HomeSeal>()
		var readAvailable = true
		var putAnswers = true
		var sealAvailable = true
		var outcome = "applied"
		var refusal: String? = null
		var conflictRecord: AssistantHomeRecord? = null
		var landsUnanswered = false
		val opened = mutableMapOf<Pair<String, Long>, Pair<ContentEnvelope, AssistantHomeSealed>>()
		var onRead: (suspend () -> Unit)? = null

		override suspend fun read(): AssistantHomeReadResult? {
			onRead?.invoke()
			return current.takeIf { readAvailable }
		}

		override suspend fun put(baseVersion: Long, gatewayId: String?, sealed: ContentEnvelope?): HomePut {
			puts += SentPut(baseVersion, gatewayId, sealed)
			if (landsUnanswered) current = AssistantHomeReadResult(AssistantHomeRecord(baseVersion + 1, gatewayId, sealed))
			if (!putAnswers) return HomePut.Uncertain(null)
			// As the Router: a stale base conflicts.
			if (outcome == "applied" && (current.record?.version ?: 0L) != baseVersion) return HomePut.Conflict(current.record)
			val record = when (outcome) {
				"applied", UNCERTAIN -> AssistantHomeRecord(baseVersion + 1, gatewayId, sealed)
				"conflict" -> conflictRecord ?: current.record ?: AssistantHomeRecord(baseVersion + 1, gatewayId, sealed)
				else -> current.record
			}
			if (outcome != "refused") current = AssistantHomeReadResult(record)
			return homePutOf(AssistantHomePutResult(outcome = outcome, record = record.takeIf { outcome != UNCERTAIN }, refusal = refusal))
		}

		override fun seal(gatewayId: String, version: Long, sealed: AssistantHomeSealed): ContentEnvelope? {
			seals += HomeSeal(gatewayId, version, sealed)
			return ContentEnvelope(v = 1, epoch = 1, nonce = "nonce", ciphertext = "ciphertext").takeIf { sealAvailable }
		}

		override fun open(gatewayId: String, version: Long, envelope: ContentEnvelope): AssistantHomeSealed? =
			opened[gatewayId to version]?.takeIf { it.first == envelope }?.second
	}

	private val sealedStub = ContentEnvelope(v = 1, epoch = 1, nonce = "nonce", ciphertext = "ciphertext")

	private fun placedAt(version: Long, gatewayId: String) = AssistantHomeReadResult(
		AssistantHomeRecord(version, gatewayId),
		AssistantHomeReport(version, gatewayId, "placed"),
	)

	private class FakeGateway(var home: String?) : AssistantGateway {
		val refusingState = mutableSetOf<String>()
		val deaf = mutableSetOf<String>()
		val calls = mutableListOf<Pair<String, String>>()
		val states = mutableMapOf<String, ConsoleAssistantStateResult>()
		var approveEverySend: Boolean? = null
		var rules = AssistantWatcherRules(emptyList(), AssistantRuleOtherwise(action = "inbox", revision = 0L), revision = 0L)
		var gate: CompletableDeferred<Unit>? = null

		private fun stateOf(gatewayId: String) = states[gatewayId] ?: ConsoleAssistantStateResult(
			workdir = "~/notes".takeIf { gatewayId == home },
			team = "host.assistant".takeIf { gatewayId == home },
			watchers = listOf(watcher().copy(fields = listOf("reason"), rules = rules)),
			approveEverySend = approveEverySend,
		)

		override suspend fun rules(gatewayId: String, op: ConsoleOp): RuleSaved {
			if (gatewayId in deaf) return RuleSaved.Unreachable
			val put = op as ConsoleOp.AssistantOtherwisePut
			if (put.otherwise.revision != rules.otherwise.revision) return RuleSaved.Refused("revision is stored", rules)
			rules = rules.copy(otherwise = put.otherwise.copy(revision = put.otherwise.revision + 1), revision = rules.revision + 1)
			return RuleSaved.Stored(rules)
		}

		override suspend fun call(gatewayId: String, op: ConsoleOp): AssistantAnswer {
			calls += gatewayId to op::class.simpleName.orEmpty()
			gate?.await()
			if (gatewayId in deaf) return AssistantAnswer.Unreachable
			if (gatewayId in refusingState) return AssistantAnswer.Refused("content key unavailable")
			return when (op) {
				ConsoleOp.AssistantState -> AssistantAnswer.State(stateOf(gatewayId))
				is ConsoleOp.AssistantSafety -> {
					approveEverySend = op.approveEverySend
					AssistantAnswer.State(stateOf(gatewayId))
				}
				else -> AssistantAnswer.State(stateOf(gatewayId))
			}
		}

		override suspend fun preview(gatewayId: String, op: ConsoleOp.AssistantRulesPreview): ConsoleAssistantPreviewResult? = null
	}

	private class Host(
		override val gateway: AssistantGateway?,
		override val homeRouter: AssistantHomeRouter? = FakeHomeRouter(),
	) : AssistantHost {
		val persistedRoles = mutableListOf<Map<String, String>>()
		val persistedHomes = mutableListOf<AssistantHome.Read>()

		override fun persistRoles(roles: Map<String, String>) {
			persistedRoles += roles
		}

		override fun persistHome(home: AssistantHome.Read) {
			persistedHomes += home
		}
	}

	private fun ops(fake: FakeGateway, vararg gatewayIds: String): Pair<AssistantOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState(gateways = testRegistry(*gatewayIds)))
		return AssistantOps(state, Host(fake)) to state
	}

	private fun assistantState(
		workdir: String? = null,
		approveEverySend: Boolean? = null,
		watchers: List<AssistantWatcher> = emptyList(),
	) = ConsoleAssistantStateResult(workdir = workdir, watchers = watchers, approveEverySend = approveEverySend)

	private fun stateWithHome(
		fake: FakeGateway,
		router: FakeHomeRouter,
		gatewayIds: List<String>,
	): Pair<AssistantOps, MutableStateFlow<ChatState>> {
		val home = router.current.record
		val state = MutableStateFlow(
			ChatState(
				gateways = testRegistry(*gatewayIds.toTypedArray()),
				assistantHome = AssistantHome.Read(home, router.current.report),
			),
		)
		return AssistantOps(state, Host(fake, router)) to state
	}

	@Test
	fun aMoveCarriesFreshHomeSettingsAtTheHeldVersion() = runBlocking {
		val rules = AssistantWatcherRules(
			rules = listOf(AssistantRule("urgent", emptyList(), "notify", 3L)),
			otherwise = AssistantRuleOtherwise("inbox", 4L),
			revision = 5L,
		)
		val fresh = assistantState(
			workdir = "~/old",
			approveEverySend = false,
			watchers = listOf(
				watcher(grants = listOf("current-grant", "unused-grant")).copy(rules = rules),
				watcher(grants = listOf("no-rules")).copy(id = "other", rules = null),
			),
		)
		val fake = FakeGateway(home = "sakura").apply {
			states["sakura"] = fresh
		}
		val router = FakeHomeRouter(placedAt(7L, "sakura"))
		val (ops, state) = stateWithHome(fake, router, listOf("sakura", "mikan"))
		state.value = state.value.copy(
			gateways = state.value.gateways.withEntry("sakura") {
				it.copy(assistant = AssistantWord.Answered(assistantState(approveEverySend = true)))
			},
		)

		assertNull(ops.moveAssistant("mikan", "~/new"))

		assertEquals(1, router.puts.size)
		assertEquals(7L, router.puts.single().baseVersion)
		assertEquals("mikan", router.puts.single().gatewayId)
		assertTrue(router.puts.single().sealed != null)
		assertEquals("mikan", router.seals.single().gatewayId)
		assertEquals(8L, router.seals.single().version)
		assertEquals("~/new", router.seals.single().sealed.workdirPath)
		assertEquals(carriedOf(fresh), router.seals.single().sealed.carried)
		assertEquals("mikan", assistantGateway(state.value))
		assertEquals(listOf("sakura" to "AssistantState"), fake.calls)
		// The old home's answer predates the choice.
		assertNull(state.value.gateways.assistantOn("sakura"))
	}

	@Test
	fun anOfflineHomeIsAbandonedOnlyOnceConfirmed() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val router = FakeHomeRouter(placedAt(3L, "sakura"))
		val (ops, state) = stateWithHome(fake, router, listOf("sakura", "mikan"))
		state.value = state.value.copy(
			gateways = state.value.gateways.copy(
				gateways = state.value.gateways.gateways.map { it.copy(connected = it.id != "sakura") },
			),
		)

		assertTrue(ops.moveAssistant("mikan", "~/new") != null)
		assertTrue(router.puts.isEmpty())

		assertNull(ops.moveAssistant("mikan", "~/new", abandoning = "sakura"))

		assertNull(router.seals.single().sealed.carried)
		assertEquals("mikan", router.puts.single().gatewayId)
		assertTrue(fake.calls.isEmpty())
	}

	@Test
	fun anUnplacedHomeCarriesWhatTheRecordSealed() = runBlocking {
		val carried = AssistantHomeCarried(approveEverySend = false, watchers = emptyList())
		val fake = FakeGateway(home = null)
		val router = FakeHomeRouter(AssistantHomeReadResult(AssistantHomeRecord(4L, "mikan", sealedStub))).apply {
			opened["mikan" to 4L] = sealedStub to AssistantHomeSealed(workdirPath = "~/old", carried = carried)
		}
		val (ops, _) = stateWithHome(fake, router, listOf("mikan", "yuzu"))

		assertNull(ops.moveAssistant("yuzu", "~/new"))

		assertEquals(AssistantHomeSealed(workdirPath = "~/new", carried = carried), router.seals.single().sealed)
		// Its own answer may predate the apply.
		assertTrue(fake.calls.isEmpty())
	}

	@Test
	fun anUnknownOutcomeCountsOnlyAsThisExactWrite() = runBlocking {
		val router = FakeHomeRouter(placedAt(2L, "sakura")).apply { outcome = UNCERTAIN }
		val (ops, state) = stateWithHome(FakeGateway(home = "sakura"), router, listOf("sakura", "mikan"))

		assertNull(ops.moveAssistant("mikan", "~/new"))
		assertEquals("mikan", assistantGateway(state.value))
		assertNull(state.value.homeFailure)

		val lost =FakeHomeRouter(placedAt(5L, "sakura")).apply {
			putAnswers = false
			landsUnanswered = true
		}
		val (removing, removed) = stateWithHome(FakeGateway(home = "sakura"), lost, listOf("sakura"))
		assertNull(removing.removeAssistant())
		assertNull(assistantGateway(removed.value))
	}

	@Test
	fun aSeedPausedAcrossAReprovisionSendsNothing() = runBlocking {
		val gate = CompletableDeferred<Unit>()
		val fake = FakeGateway(home = null).apply {
			states["alpha"] = assistantState(workdir = "~/holder")
			this.gate = gate
		}
		val router = FakeHomeRouter()
		val state = MutableStateFlow(ChatState(gateways = testRegistry("alpha")))
		val ops = AssistantOps(state, Host(fake, router))

		val seeding = async { ops.readHome() }
		yield()
		ops.forgetHome()
		ops.fetchHome()
		gate.complete(Unit)
		seeding.await()

		assertTrue(router.puts.isEmpty())
	}

	@Test
	fun aReadBegunBeforeAReprovisionLandsNothing() = runBlocking {
		val router = FakeHomeRouter(placedAt(9L, "sakura"))
		val state = MutableStateFlow(ChatState(gateways = testRegistry("sakura")))
		val host = Host(FakeGateway(home = "sakura"), router)
		val ops = AssistantOps(state, host)
		router.onRead = { ops.forgetHome() }

		ops.fetchHome()

		assertEquals(AssistantHome.Unread, state.value.assistantHome)
		assertTrue(host.persistedHomes.isEmpty())
	}

	@Test
	fun anAnswerAskedBeforeANewChoiceIsDropped() = runBlocking {
		val gate = CompletableDeferred<Unit>()
		val fake = FakeGateway(home = "sakura").apply { this.gate = gate }
		val router = FakeHomeRouter(placedAt(5L, "sakura"))
		val (ops, state) = stateWithHome(fake, router, listOf("sakura", "mikan"))

		val late = async { ops.refresh("sakura") }
		yield()
		router.current = placedAt(6L, "mikan")
		ops.readHome()
		gate.complete(Unit)
		late.await()

		assertNull(state.value.gateways.assistantOn("sakura"))
	}

	@Test
	fun onlyAPlacedHomeIsStampedAndAnEqualReadRepairsTheStamp() = runBlocking {
		val moving = AssistantHomeReadResult(AssistantHomeRecord(5L, "sakura"))
		val router = FakeHomeRouter(moving)
		val state = MutableStateFlow(
			ChatState(domainId = "dom", gateways = testRegistry("sakura"), assistantHome = AssistantHome.Read(moving.record, null)),
		)
		val host = Host(FakeGateway(home = "sakura"), router)
		val ops = AssistantOps(state, host)

		ops.readHome()
		assertTrue(host.persistedRoles.isEmpty())

		router.current = placedAt(5L, "sakura")
		ops.readHome()
		state.value = state.value.copy(roles = emptyMap())
		ops.readHome()

		assertEquals(mapOf("dom.sakura.host.assistant" to ASSISTANT_ROLE), host.persistedRoles.last())
	}

	@Test
	fun anUnreadableHomeStopsMoveBeforeSealingOrPutting() = runBlocking {
		val fake = FakeGateway(home = "sakura").apply { deaf += "sakura" }
		val router = FakeHomeRouter(placedAt(2L, "sakura"))
		val (ops, _) = stateWithHome(fake, router, listOf("sakura", "mikan"))

		val failure = ops.moveAssistant("mikan", "~/new")

		assertTrue(failure != null)
		assertEquals(listOf("sakura" to "AssistantState"), fake.calls)
		assertTrue(router.seals.isEmpty())
		assertTrue(router.puts.isEmpty())
	}

	@Test
	fun missingContentKeyStopsMoveBeforePut() = runBlocking {
		val router = FakeHomeRouter().apply { sealAvailable = false }
		val (ops, _) = stateWithHome(FakeGateway(home = null), router, listOf("mikan"))

		val failure = ops.moveAssistant("mikan", "~/notes")

		assertTrue(failure != null)
		assertEquals(HomeSeal("mikan", 1L, AssistantHomeSealed(workdirPath = "~/notes")), router.seals.single())
		assertTrue(router.puts.isEmpty())
	}

	@Test
	fun aRefusedOrUnansweredPutKeepsTheRecordAndLandsAsFailed() = runBlocking {
		val record = AssistantHomeRecord(version = 2L, gatewayId = "sakura")
		for (unanswered in listOf(false, true)) {
			val router = FakeHomeRouter(placedAt(2L, "sakura")).apply {
				outcome = "refused"
				refusal = "unroutable"
				putAnswers = !unanswered
			}
			val (ops, state) = stateWithHome(FakeGateway(home = "sakura"), router, listOf("sakura", "mikan"))

			val moved = ops.moveAssistant("mikan", "~/notes")
			val removed = ops.removeAssistant()

			assertTrue(moved != null && removed != null)
			assertEquals(record, (state.value.assistantHome as AssistantHome.Read).record)
			assertEquals(AssistantRoot.Failed(removed!!), assistantRoot(state.value))
		}
	}

	@Test
	fun anOlderReadLandsNothingAndARepeatKeepsItsReport() = runBlocking {
		val held = AssistantHome.Read(
			AssistantHomeRecord(version = 5L, gatewayId = "sakura"),
			AssistantHomeReport(version = 5L, gatewayId = "sakura", outcome = "placed"),
		)
		val router = FakeHomeRouter(AssistantHomeReadResult(AssistantHomeRecord(version = 4L, gatewayId = "mikan")))
		val state = MutableStateFlow(ChatState(gateways = testRegistry("sakura", "mikan"), assistantHome = held))
		val host = Host(FakeGateway(home = "sakura"), router)

		assertTrue(AssistantOps(state, host).readHome())

		assertEquals(held, state.value.assistantHome)
		assertTrue(host.persistedHomes.isEmpty())
		assertEquals(held, newerHome(held, AssistantHome.Read(held.record, null)))
	}

	@Test
	fun anUnansweredReadKeepsTheHeldHomeAndSeedsNothing() = runBlocking {
		val router = FakeHomeRouter().apply { readAvailable = false }
		val state = MutableStateFlow(ChatState(gateways = testRegistry("alpha")))
		val host = Host(FakeGateway(home = "alpha"), router)

		assertFalse(AssistantOps(state, host).readHome())

		assertEquals(AssistantHome.Unread, state.value.assistantHome)
		assertTrue(host.persistedHomes.isEmpty() && router.puts.isEmpty())
	}

	@Test
	fun aConflictAdoptsTheRouterRecordWithoutFailure() = runBlocking {
		val winner = AssistantHomeRecord(version = 9L, gatewayId = "yuzu")
		val router = FakeHomeRouter(placedAt(3L, "sakura")).apply {
			outcome = "conflict"
			conflictRecord = winner
		}
		val fake = FakeGateway(home = "sakura")
		fake.states["sakura"] = assistantState(workdir = "~/old", approveEverySend = true)
		val (ops, state) = stateWithHome(fake, router, listOf("sakura", "mikan", "yuzu"))
		state.value = state.value.copy(homeFailure = "previous failure")

		assertNull(ops.moveAssistant("mikan", "~/new"))

		assertEquals(3L, router.puts.single().baseVersion)
		assertEquals("mikan", router.puts.single().gatewayId)
		assertEquals("yuzu", assistantGateway(state.value))
		assertEquals(AssistantRoot.Moving("yuzu"), assistantRoot(state.value))
		assertNull(state.value.homeFailure)
	}

	@Test
	fun removePutsNobodyWithoutSealing() = runBlocking {
		val record = AssistantHomeRecord(version = 5L, gatewayId = "sakura")
		val router = FakeHomeRouter(AssistantHomeReadResult(record))
		val (ops, state) = stateWithHome(FakeGateway(home = "sakura"), router, listOf("sakura"))

		assertNull(ops.removeAssistant())

		assertEquals(listOf(SentPut(5L, null, null)), router.puts)
		assertTrue(router.seals.isEmpty())
		assertNull(assistantGateway(state.value))
	}

	@Test
	fun readHomePersistsTheRecordAndClearsAnOlderFailure() = runBlocking {
		val held = AssistantHomeRecord(version = 4L, gatewayId = "sakura")
		val latest = AssistantHomeRecord(version = 5L, gatewayId = "sakura")
		val report = AssistantHomeReport(version = 5L, gatewayId = "sakura", outcome = "placed")
		val router = FakeHomeRouter(AssistantHomeReadResult(latest, report))
		val state = MutableStateFlow(
			ChatState(
				domainId = "domain",
				gateways = testRegistry("sakura"),
				assistantHome = AssistantHome.Read(held, null),
				homeFailure = "old failure",
			),
		)
		val host = Host(FakeGateway(home = "sakura"), router)
		val ops = AssistantOps(state, host)

		assertTrue(ops.readHome())

		assertEquals(listOf(AssistantHome.Read(latest, report)), host.persistedHomes)
		assertEquals(AssistantRoot.Placed("domain.sakura.host.assistant"), assistantRoot(state.value))
		assertNull(state.value.homeFailure)
		// A past home's thread stays the assistant's.
		assertEquals(mapOf("domain.sakura.host.assistant" to ASSISTANT_ROLE), host.persistedRoles.last())
	}

	@Test
	fun aNeverWrittenHomeSeedsOnlyOneFreshRegisteredHolder() = runBlocking {
		val fake = FakeGateway(home = null)
		val rules = AssistantWatcherRules(emptyList(), AssistantRuleOtherwise("notify", 2L), 3L)
		val holder = assistantState(
			workdir = "~/holder",
			approveEverySend = false,
			watchers = listOf(watcher(grants = listOf("holder-grant")).copy(rules = rules)),
		)
		fake.states["alpha"] = holder
		fake.states["beta"] = assistantState()
		fake.states["never"] = assistantState(workdir = "~/not-registered")
		val router = FakeHomeRouter()
		val registry = testRegistry("alpha", "beta").copy(
			gateways = testRegistry("alpha", "beta").gateways + GatewayEntry(
				id = "never",
				connected = true,
				incarnation = 0,
				lastRegisteredAt = 0,
			),
		)
		val state = MutableStateFlow(ChatState(gateways = registry))
		val ops = AssistantOps(state, Host(fake, router))

		assertTrue(ops.readHome())

		assertEquals(0L, router.puts.single().baseVersion)
		assertEquals("alpha", router.puts.single().gatewayId)
		assertEquals("~/holder", router.seals.single().sealed.workdirPath)
		assertEquals(carriedOf(holder), router.seals.single().sealed.carried)
		assertEquals(setOf("alpha", "beta"), fake.calls.map { it.first }.toSet())
		assertFalse(fake.calls.any { it.first == "never" })
	}

	@Test
	fun aNeverWrittenHomeDoesNotSeedAmbiguousSilentOrEmptyAnswers() = runBlocking {
		val cases = listOf(
			mapOf(
				"alpha" to assistantState(workdir = "~/one"),
				"beta" to assistantState(workdir = "~/two"),
			) to emptySet<String>(),
			mapOf(
				"alpha" to assistantState(workdir = "~/one"),
				"beta" to assistantState(),
			) to setOf("beta"),
			mapOf(
				"alpha" to assistantState(),
				"beta" to assistantState(),
			) to emptySet(),
		)

		for ((states, deaf) in cases) {
			val fake = FakeGateway(home = null).apply {
				this.states.putAll(states)
				this.deaf += deaf
			}
			val router = FakeHomeRouter()
			val state = MutableStateFlow(ChatState(gateways = testRegistry("alpha", "beta")))
			val ops = AssistantOps(state, Host(fake, router))

			assertTrue(ops.readHome())

			assertTrue(router.puts.isEmpty())
		}
	}

	@Test
	fun aCachedRosterNeverSeeds() = runBlocking {
		val fake = FakeGateway(home = "alpha")
		val router = FakeHomeRouter()
		val cached = testRegistry("alpha").copy(provenance = RegistryProvenance.Cached)
		val state = MutableStateFlow(ChatState(gateways = cached))

		assertTrue(AssistantOps(state, Host(fake, router)).readHome())

		assertTrue(fake.calls.isEmpty() && router.puts.isEmpty())
	}

	@Test
	fun carriedOfKeepsSafetyRulesAndOneGrantPerConfiguredWatcher() {
		val rules = AssistantWatcherRules(emptyList(), AssistantRuleOtherwise("inbox", 1L), 2L)
		val state = assistantState(
			approveEverySend = false,
			watchers = listOf(
				watcher(grants = listOf("first-grant", "second-grant")).copy(rules = rules),
				watcher().copy(id = "unconfigured", rules = null),
			),
		)

		assertEquals(
			AssistantHomeCarried(
				approveEverySend = false,
				watchers = listOf(AssistantHomeCarriedWatcher("github", rules, "first-grant")),
			),
			carriedOf(state),
		)
	}

	@Test
	fun locationActionAnswersNoneOfflineAndMovesWithOrWithoutAbandoning() {
		val base = testRegistry("home", "target", "offline")
		val registry = base.copy(gateways = base.gateways.map { it.copy(connected = it.id != "offline") })

		assertEquals(LocationAction.None, locationAction(registry, null, null, "~/notes", null))
		assertEquals(LocationAction.None, locationAction(registry, null, "target", "  ", null))
		assertEquals(LocationAction.None, locationAction(registry, "home", "home", "~/notes", "~/notes/"))
		assertEquals(LocationAction.Offline("offline"), locationAction(registry, null, "offline", "~/notes", null))
		assertEquals(LocationAction.Move("target", null), locationAction(registry, "home", "target", "~/notes", "~/notes"))
		assertEquals(LocationAction.Move("target", "offline"), locationAction(registry, "offline", "target", "~/notes", null))
	}

	@Test
	fun aStaleSaveIsRefusedWithWhatIsHeldAndRedrawsIt() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura")
		ops.refresh("sakura")
		val drawn = { state.value.gateways.assistantOn("sakura")!!.watchers.single().rules!!.otherwise.revision }
		fake.rules = fake.rules.copy(otherwise = AssistantRuleOtherwise(action = "wake", revision = 1L))

		val answer = ops.saveOtherwise("sakura", "github", AssistantRuleOtherwise(action = "inbox", revision = 0L))

		assertEquals(1L, (answer as RuleSaved.Refused).held?.otherwise?.revision)
		assertEquals(1L, drawn())
	}

	@Test
	fun aGatewayAnswerStaysWhenItsNextReadCannotReachIt() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura")
		ops.refresh("sakura")

		fake.deaf += "sakura"
		ops.refresh("sakura")

		assertEquals(assistantState(approveEverySend = null).copy(
			workdir = "~/notes",
			team = "host.assistant",
			watchers = listOf(watcher().copy(fields = listOf("reason"), rules = fake.rules)),
		), state.value.gateways.assistantOn("sakura"))
	}

	@Test
	fun theStripAsksForASecretBeforeItCountsGithubsUnread() {
		val unset = watcher(grants = emptyList(), secret = "A GitHub token", lastSuccessAt = 1L)
		assertEquals(WatcherChip("GitHub notifications needs a secret", needsSecret = true), watcherChip(unset))
		assertEquals("GitHub notifications not checked yet", watcherChip(watcher(grants = emptyList())).text)
		assertEquals("GitHub notifications stopped", watcherChip(watcher(stopped = "GitHub refused the token")).text)
		assertEquals("GitHub notifications not checked yet", watcherChip(watcher(unread = 0L)).text)
		assertEquals("GitHub notifications · 2 unread", watcherChip(watcher(lastSuccessAt = 1L)).text)
		assertEquals(
			"GitHub notifications · 500+ unread",
			watcherChip(watcher(unread = 500L, capped = true, lastSuccessAt = 1L)).text,
		)
	}

	@Test
	fun theHealthLineSaysWhyItIsNotPollingAndCountsOnceAPollLanded() {
		val ago = { _: Long -> "5m ago" }

		assertEquals(
			"Needs a secret",
			watcherHealth(watcher(grants = emptyList(), secret = "A GitHub token", lastSuccessAt = 1L, stopped = "no token"), ago),
		)
		assertEquals("Stopped: needs a secret", watcherHealth(watcher(stopped = "needs a secret", lastSuccessAt = 1L), ago))
		assertEquals(
			"Waiting: GitHub rate limit · 2 unread",
			watcherHealth(watcher(lastSuccessAt = 1L, backoff = AssistantWatcherBackoff(1L, "GitHub rate limit")), ago),
		)
		assertEquals("Checked 5m ago · 2 unread", watcherHealth(watcher(lastSuccessAt = 1L, evicted = 3L), ago))
		assertEquals("Not checked yet", watcherHealth(watcher(), ago))
	}

	@Test
	fun settingsNameValuesOutsideTheListsByLabelAndCountInvalidRules() {
		val specs = listOf(AssistantFieldSpec.Text("type", "Type"))
		val seen = AssistantUnexpectedValues(listOf(AssistantFieldValue("type", "WorkflowRun"), AssistantFieldValue("odd", "x")), capped = true)

		assertEquals(listOf("Type: WorkflowRun", "Odd: x", "and more"), unexpectedLines(watcher().copy(fieldSpecs = specs, unexpected = seen)))
		assertEquals(emptyList<String>(), unexpectedLines(watcher()))
		assertEquals(listOf("4 rules · 1 invalid", "1 rule"), listOf(rulesCountText(4, 1), rulesCountText(1, 0)))
	}

	@Test
	fun settingsShowHomeSections() {
		val placed = ConsoleAssistantStateResult(workdir = "~/notes", watchers = emptyList())
		val safe = placed.copy(approveEverySend = true)

		assertEquals(listOf(AssistantSection.LIVES_ON), assistantSections(home = null, placed = null))
		assertEquals(listOf(AssistantSection.LIVES_ON, AssistantSection.WATCHERS), assistantSections("sakura", placed))
		assertEquals(
			listOf(AssistantSection.LIVES_ON, AssistantSection.SAFETY, AssistantSection.WATCHERS),
			assistantSections("sakura", safe),
		)
		assertEquals(listOf(AssistantSection.LIVES_ON, AssistantSection.WATCHERS), assistantSections("sakura", placed.copy(approveEverySend = null)))
	}

	@Test
	fun settingSafetyLandsTheChosenGatewayAnswer() = runBlocking {
		val fake = FakeGateway(home = "sakura").apply { approveEverySend = true }
		val (ops, state) = ops(fake, "sakura")
		ops.refresh("sakura")

		val answer = ops.setSafety("sakura", false)

		assertFalse((answer as AssistantAnswer.State).state.approveEverySend!!)
		assertFalse(state.value.gateways.assistantOn("sakura")!!.approveEverySend!!)
	}

	@Test
	fun aRuleDraftStaysUntilItLandsOrIsCancelled() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, _) = ops(fake, "sakura")
		val key = RuleDraftKey("sakura", "github", RuleSlot.Otherwise)
		val stale = RuleDraft("otherwise", emptyList(), "wake", 5L)
		val save: suspend (RuleDraft) -> RuleSaved = { ops.saveOtherwise("sakura", "github", it.toOtherwise()) }
		ops.editRule(key, stale)

		assertTrue(ops.sendRule(key, stale, RuleEdit.SAVE, save) is SaveOutcome.Offer)
		val offered = ops.ruleDrafts.value[key]!!
		assertEquals(Pair(0L, "wake"), offered.draft.revision to offered.draft.action)
		assertEquals(SaveOutcome.Done, ops.sendRule(key, offered.draft, RuleEdit.SAVE, save))
		assertNull(ops.ruleDrafts.value[key])
		assertTrue(editorLanded(offered.opening, ops.ruleLanded.value[key]))

		ops.editRule(key, stale)
		ops.cancelRule(key)
		assertNull(ops.ruleDrafts.value[key])

		val answer = CompletableDeferred<RuleSaved>()
		val pending = async { ops.sendRule(key, stale, RuleEdit.SAVE) { answer.await() } }
		yield()
		ops.cancelRule(key)
		answer.complete(RuleSaved.Unreachable)
		pending.await()
		assertNull(ops.ruleDrafts.value[key])

		val late = CompletableDeferred<RuleSaved>()
		val first = async { ops.sendRule(key, stale, RuleEdit.SAVE) { late.await() } }
		yield()
		ops.cancelRule(key)
		val reopened = stale.copy(action = "inbox")
		ops.editRule(key, reopened)
		late.complete(RuleSaved.Stored(fake.rules))
		first.await()
		val kept = ops.ruleDrafts.value[key]!!
		assertEquals(HeldRuleDraft(reopened, kept.opening), kept)
		assertFalse(editorLanded(kept.opening, ops.ruleLanded.value[key]))
	}

	@Test
	fun anUneditedSaveLandsTheOpeningItsEditorHeld() = runBlocking {
		val (ops, _) = ops(FakeGateway(home = "sakura"), "sakura")
		val key = RuleDraftKey("sakura", "github", RuleSlot.Otherwise)
		val untouched = RuleDraft("otherwise", emptyList(), "inbox", 0L)

		val shown = ops.holdRule(key, untouched)
		ops.sendRule(key, untouched, RuleEdit.SAVE) { ops.saveOtherwise("sakura", "github", it.toOtherwise()) }

		assertTrue(editorLanded(shown, ops.ruleLanded.value[key]))
	}

	@Test
	fun aPagesResultStaysUnderItsKeyAndASecondOpWhileBusyIsDropped() = runBlocking {
		val (ops, _) = ops(FakeGateway(home = "sakura"), "sakura")
		val list = WorkKey.RuleList("sakura", "github")
		val gate = CompletableDeferred<String?>()
		var second = false

		val first = async { ops.runWork(list) { gate.await() } }
		yield()
		ops.runWork(list) { second = true; null }
		ops.runWork(WorkKey.Settings) { "moved" }
		gate.complete("revision is stored")
		first.await()

		assertFalse(second)
		assertEquals(PageWork(said = "revision is stored"), ops.work.value[list])
		assertEquals(PageWork(said = "moved"), ops.work.value[WorkKey.Settings])
	}

	@Test
	fun settingsListWhatTheAssistantMayDoAndNothingFromAnOlderGateway() {
		val done = AssistantActionDescriptor("github_done", "Mark done", "Clears threads from your GitHub inbox.")

		assertEquals(listOf(done), watcherActions(watcher().copy(actions = listOf(done))))
		assertEquals(emptyList<AssistantActionDescriptor>(), watcherActions(watcher()))
	}

	@Test
	fun onlyAStoppedWatcherHoldingItsSecretOffersRetry() {
		assertTrue(canRetry(watcher(stopped = "GitHub refused the token")))
		assertFalse(canRetry(watcher(grants = emptyList(), stopped = "needs a secret")))
		assertFalse(canRetry(watcher()))
	}

	@Test
	fun aMoveIsOfferedOnlyWhenItChangesSomething() {
		assertFalse(placementMoves(home = "sakura", target = "sakura", folder = "~/notes/", workdir = "~/notes"))
		assertTrue(placementMoves(home = "sakura", target = "sakura", folder = "~/journal", workdir = "~/notes"))
		assertTrue(placementMoves(home = "sakura", target = "mikan", folder = "~/notes", workdir = "~/notes"))
		assertTrue(placementMoves(home = null, target = "sakura", folder = "~/notes", workdir = null))
		assertFalse(placementMoves(home = null, target = null, folder = "~/notes", workdir = null))
		assertEquals("/", folderOf("/"))
	}

	@Test
	fun theAssistantIsKnownByItsMarkNeverItsName() {
		val marked = Team(name = "dom.sakura.host.assistant", presence = Presence.ended(), role = ASSISTANT_ROLE)
		val namedOnly = Team(name = "dom.mikan.host.assistant", presence = Presence.ended())
		val state = ChatState(domainId = "dom", teams = listOf(marked, namedOnly))

		assertTrue(isAssistant(state, marked.name))
		assertFalse(isAssistant(state, namedOnly.name))
		assertEquals(listOf(namedOnly), localSessions(listOf(marked, namedOnly), "dom"))
	}
}
