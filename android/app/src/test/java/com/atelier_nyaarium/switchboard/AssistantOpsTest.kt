package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherBackoff
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun watcher(
	grants: List<String> = listOf("gh-token"),
	unread: Long = 2L,
	evicted: Long = 0L,
	lastSuccessAt: Long? = null,
	backoff: AssistantWatcherBackoff? = null,
	stopped: String? = null,
) = AssistantWatcher(
	id = "github",
	label = "GitHub notifications",
	grants = grants,
	unread = unread,
	evicted = evicted,
	lastSuccessAt = lastSuccessAt,
	backoff = backoff,
	stopped = stopped,
)

class AssistantOpsTest {
	/** One home at a time; a gateway in `refusing` turns down a place, one in `deaf` answers nothing. */
	private class FakeGateway(var home: String?) : AssistantGateway {
		val refusing = mutableSetOf<String>()
		val deaf = mutableSetOf<String>()
		val calls = mutableListOf<Pair<String, String>>()

		private fun stateOf(gatewayId: String) = ConsoleAssistantStateResult(
			workdir = "~/notes".takeIf { gatewayId == home },
			team = "host.assistant".takeIf { gatewayId == home },
			watchers = listOf(watcher()),
		)

		override suspend fun call(gatewayId: String, op: ConsoleOp): AssistantAnswer {
			calls += gatewayId to op::class.simpleName.orEmpty()
			if (gatewayId in deaf) return AssistantAnswer.Unreachable
			return when (op) {
				is ConsoleOp.AssistantPlace -> {
					if (gatewayId in refusing) return AssistantAnswer.Refused("held by another session")
					home = gatewayId
					AssistantAnswer.State(stateOf(gatewayId))
				}
				ConsoleOp.AssistantRelease -> {
					if (home == gatewayId) home = null
					AssistantAnswer.State(stateOf(gatewayId))
				}
				else -> AssistantAnswer.State(stateOf(gatewayId))
			}
		}
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
		val fake = FakeGateway(home = "sakura").apply { deaf += "sakura" }
		val (ops, _) = ops(fake, "sakura", "mikan")

		val moved = ops.move("mikan", "~/notes")

		assertEquals(AssistantMoved.StillOn(listOf("sakura")), moved)
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
	fun theStripAsksForASecretBeforeItCountsAnything() {
		assertEquals(WatcherChip("GitHub notifications needs a secret", needsSecret = true), watcherChip(watcher(grants = emptyList())))
		assertEquals("GitHub notifications stopped", watcherChip(watcher(stopped = "GitHub refused the token")).text)
		assertEquals("GitHub notifications · 2 in inbox", watcherChip(watcher()).text)
	}

	@Test
	fun theHealthLineSaysWhyItIsNotPolling() {
		val ago = { _: Long -> "5m ago" }

		assertEquals("Stopped: needs a secret", watcherHealth(watcher(stopped = "needs a secret"), ago))
		assertEquals("Waiting: GitHub rate limit", watcherHealth(watcher(backoff = AssistantWatcherBackoff(1L, "GitHub rate limit")), ago))
		assertEquals("Checked 5m ago · 3 lost unread", watcherHealth(watcher(lastSuccessAt = 1L, evicted = 3L), ago))
		assertEquals("Not checked yet", watcherHealth(watcher(), ago))
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
	fun theAssistantIsReachedByItsMarkNotItsName() {
		val marked = Team(name = "dom.sakura.host.assistant", presence = Presence.ended(), role = ASSISTANT_ROLE)
		val namedOnly = Team(name = "dom.mikan.host.assistant", presence = Presence.ended())

		assertEquals("dom.sakura.host.assistant", assistantAddress(listOf(marked, namedOnly), "dom", "sakura"))
		assertEquals(listOf(namedOnly), localSessions(listOf(marked, namedOnly), "dom"))
		assertNull(assistantAddress(emptyList(), null, "sakura"))
	}
}
