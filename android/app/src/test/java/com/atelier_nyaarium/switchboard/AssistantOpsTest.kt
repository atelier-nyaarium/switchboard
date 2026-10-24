package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantActionDescriptor
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantFieldValue
import com.atelier_nyaarium.switchboard.proto.AssistantUnexpectedValues
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherBackoff
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.assistant.RuleDraft
import com.atelier_nyaarium.switchboard.assistant.RuleEdit
import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.SaveOutcome
import com.atelier_nyaarium.switchboard.assistant.editorLanded
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
	/** One home at a time; a gateway in `refusing` turns down a place, one in `deaf` answers nothing. */
	private class FakeGateway(var home: String?) : AssistantGateway {
		val refusing = mutableSetOf<String>()
		val refusingState = mutableSetOf<String>()
		val deaf = mutableSetOf<String>()
		val calls = mutableListOf<Pair<String, String>>()
		var approveEverySend: Boolean? = null
		var rules = AssistantWatcherRules(emptyList(), AssistantRuleOtherwise(action = "inbox", revision = 0L), revision = 0L)

		private fun stateOf(gatewayId: String) = ConsoleAssistantStateResult(
			workdir = "~/notes".takeIf { gatewayId == home },
			team = "host.assistant".takeIf { gatewayId == home },
			watchers = listOf(watcher().copy(fields = listOf("reason"), rules = rules)),
			approveEverySend = approveEverySend,
		)

		/** Only the catch-all, which is all these tests save. */
		override suspend fun rules(gatewayId: String, op: ConsoleOp): RuleSaved {
			if (gatewayId in deaf) return RuleSaved.Unreachable
			val put = op as ConsoleOp.AssistantOtherwisePut
			if (put.otherwise.revision != rules.otherwise.revision) return RuleSaved.Refused("revision is stored", rules)
			rules = rules.copy(otherwise = put.otherwise.copy(revision = put.otherwise.revision + 1), revision = rules.revision + 1)
			return RuleSaved.Stored(rules)
		}

		override suspend fun call(gatewayId: String, op: ConsoleOp): AssistantAnswer {
			calls += gatewayId to op::class.simpleName.orEmpty()
			if (gatewayId in deaf) return AssistantAnswer.Unreachable
			return when (op) {
				is ConsoleOp.AssistantPlace -> {
					if (gatewayId in refusing) return AssistantAnswer.Refused("held by another session")
					home = gatewayId
					AssistantAnswer.State(stateOf(gatewayId))
				}
				is ConsoleOp.AssistantSafety -> {
					approveEverySend = op.approveEverySend
					AssistantAnswer.State(stateOf(gatewayId))
				}
				ConsoleOp.AssistantRelease -> {
					if (home == gatewayId) home = null
					AssistantAnswer.State(stateOf(gatewayId))
				}
				else ->
					if (gatewayId in refusingState) AssistantAnswer.Refused("content key unavailable")
					else AssistantAnswer.State(stateOf(gatewayId))
			}
		}

		override suspend fun preview(gatewayId: String, op: ConsoleOp.AssistantRulesPreview): ConsoleAssistantPreviewResult? = null
	}

	private class Host(override val gateway: AssistantGateway?) : AssistantHost

	private fun ops(fake: FakeGateway, vararg gatewayIds: String): Pair<AssistantOps, MutableStateFlow<ChatState>> {
		val state = MutableStateFlow(ChatState(gateways = testRegistry(*gatewayIds)))
		return AssistantOps(state, Host(fake)) to state
	}

	@Test
	fun aMovePlacesFirstThenReleasesWhereItLivedEvenBeforeAnyRead() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura", "mikan")

		val moved = ops.move("mikan", "~/notes")
		ops.refreshAll()

		assertEquals(AssistantMoved.Moved, moved)
		assertEquals(listOf("mikan"), state.value.gateways.assistantHomes())
		val order = fake.calls.filter { it.second != "AssistantState" }
		assertEquals(listOf("mikan" to "AssistantPlace", "sakura" to "AssistantRelease"), order)
	}

	@Test
	fun aRefusedPlaceLeavesTheOldHomeAlone() = runBlocking {
		val fake = FakeGateway(home = "sakura").apply { refusing += "mikan" }
		val (ops, state) = ops(fake, "sakura", "mikan")
		ops.refreshAll()

		val moved = ops.move("mikan", "~/notes")

		assertEquals(AssistantMoved.Refused("held by another session"), moved)
		assertEquals(listOf("sakura"), state.value.gateways.assistantHomes())
		assertFalse(fake.calls.any { it.second == "AssistantRelease" })
	}

	@Test
	fun aGatewayThatCouldNotBeReadIsNamedRatherThanAssumedEmpty() = runBlocking {
		val unreachable = FakeGateway(home = "sakura").apply { deaf += "sakura" }
		val refused = FakeGateway(home = "sakura").apply { refusingState += "sakura" }

		for (fake in listOf(unreachable, refused)) {
			val (ops, _) = ops(fake, "sakura", "mikan")
			assertEquals(AssistantMoved.StillOn(listOf("sakura")), ops.move("mikan", "~/notes"))
		}
	}

	@Test
	fun aRefusedReadIsHeldAsARefusalNeverAsHoldingNone() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura")
		ops.refreshAll()
		fake.refusingState += "sakura"

		ops.refresh("sakura")

		assertEquals(AssistantWord.Refused, state.value.gateways.entry("sakura")?.assistant)
		assertFalse(assistantReleased(state.value, "sakura"))
		assertEquals(AssistantRoot.Unavailable(canPlace = true), assistantRoot(state.value, null))
	}

	@Test
	fun aConfirmedReleaseIsDrawnEvenWhenTheNextReadIsRefused() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura")
		ops.refreshAll()
		fake.refusingState += "sakura"

		ops.release("sakura")

		assertTrue(assistantReleased(state.value, "sakura"))
	}

	@Test
	fun aReleaseThatDoesNotLandIsNamed() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, _) = ops(fake, "sakura", "mikan")
		ops.refreshAll()
		fake.deaf += "sakura"

		val moved = ops.move("mikan", "~/notes")

		assertEquals(AssistantMoved.StillOn(listOf("sakura")), moved)
		assertTrue(movedText(moved)!!.contains("sakura"))
	}

	@Test
	fun aStaleSaveIsRefusedWithWhatIsHeldAndRedrawsIt() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura")
		ops.refreshAll()
		val drawn = { state.value.gateways.assistantOn("sakura")!!.watchers.single().rules!!.otherwise.revision }
		// Another phone saves first.
		fake.rules = fake.rules.copy(otherwise = AssistantRuleOtherwise(action = "wake", revision = 1L))

		val answer = ops.saveOtherwise("sakura", "github", AssistantRuleOtherwise(action = "inbox", revision = 0L))

		assertEquals(1L, (answer as RuleSaved.Refused).held?.otherwise?.revision)
		assertEquals(1L, drawn())
	}

	@Test
	fun anUnreachableGatewayKeepsWhatItDrew() = runBlocking {
		val fake = FakeGateway(home = "sakura")
		val (ops, state) = ops(fake, "sakura")
		ops.refreshAll()

		fake.deaf += "sakura"
		ops.refresh("sakura")
		val kept = state.value.gateways.assistantHomes()

		assertEquals(listOf("sakura"), kept)
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
	fun settingsShowWatchersOnlyWhereItLives() {
		val placed = ConsoleAssistantStateResult(workdir = "~/notes", watchers = emptyList())

		assertEquals(listOf(AssistantSection.LIVES_ON), assistantSections(home = null, placed = null))
		assertEquals(listOf(AssistantSection.LIVES_ON, AssistantSection.WATCHERS), assistantSections("sakura", placed))
		assertEquals(
			listOf(AssistantSection.LIVES_ON, AssistantSection.SAFETY, AssistantSection.WATCHERS),
			assistantSections("sakura", placed, placed.copy(approveEverySend = true)),
		)
		assertEquals(
			listOf(AssistantSection.LIVES_ON, AssistantSection.WATCHERS),
			assistantSections("sakura", placed, placed.copy(approveEverySend = null)),
		)
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
