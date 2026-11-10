package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.UNNAMED_HARNESS
import com.atelier_nyaarium.switchboard.proto.readHarness
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionOpsTest {
	private class FakeHost : SessionHost {
		override val state = MutableStateFlow(ChatState(gateways = testRegistry("gw")))
		override val localDomain = "dom"
		override val forgottenUntil = mutableMapOf<String, Long>()
		override val sandboxDirs: Map<String, List<String>>? = null
		override var terminalRefreshMs = 1_000L
		override val spawnRetryWindowMs = 40_000L
		override val forgetTombstoneMs = 50_000L
		override val forgetRetryMs = 60_000L
		val created = mutableListOf<Pair<String, String>>()
		val closed = mutableListOf<String>()
		val remembered = mutableListOf<String>()
		val wakes = mutableListOf<Pair<String, String>>()
		val forgotten = mutableListOf<Triple<String, String?, String>>()
		var forgetFails = false
		var forgetSettled: String? = null
		var scheduled = 0
		var goals = 0
		var playback = 0
		var persisted = 0

		override fun forgetReadAnchor(team: String) = Unit
		override fun rememberProject(target: String) { remembered += target }
		override fun launchInBackground(block: suspend () -> Unit) { CoroutineScope(Dispatchers.Unconfined).launch { block() } }
		override suspend fun peekTerminal(team: String, sinceHash: String?) = ConsolePeekResult(kind = "tmux", hash = "hash")
		override suspend fun createSession(
			target: String,
			sessionName: String?,
			displayLabel: String?,
			workdir: String?,
			opId: String,
			harness: String,
		) = ConsoleCreateSessionResult(created = true, id = sessionName ?: "minted").also { created += target to harness }
		override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) = Unit
		override suspend fun listDirs(path: String, hostTarget: String, spawn: String) = ConsoleListDirsResult(emptyList())
		override suspend fun wake(target: String, opId: String, harness: String) { wakes += target to harness }
		override suspend fun closeSession(team: String) { closed += team }
		override suspend fun forget(team: String, boardDisposition: String?, opId: String): String? {
			forgotten += Triple(team, boardDisposition, opId)
			if (forgetFails) error("offline")
			forgetSettled?.let { throw OwnerOpFailure(it, "forget failed: $it") }
			return boardDisposition
		}
		override fun persistThreads() { persisted++ }
		override fun persistLabels() { persisted++ }
		override fun persistDrafts() { persisted++ }
		override fun cancelScheduled(team: String) { scheduled++ }
		override fun cancelGoal(team: String) { goals++ }
		override fun dropPlayback(team: String) { playback++ }
		override fun scheduleAttachmentDelete(srcs: List<String>) = Unit
	}

	@Test
	fun wakeTargetIsTheQualifiedSessionAddress() {
		assertEquals("dom.gw.host.82d560", wakeTargetOf("dom.gw.host.82d560"))
		assertNull(wakeTargetOf("host.82d560"))
	}

	@Test
	fun wakeTargetRefusesASpawnPointOrGarbage() {
		assertNull(wakeTargetOf("dom.gw.host"))
		assertNull(wakeTargetOf("host"))
		assertNull(wakeTargetOf("a.b.c.d.e"))
	}

	private fun journalDir() = Files.createTempDirectory("forget-journal").toFile()

	@Test
	fun spawnNamesItsCliRecordsProjectAndSettlesPendingState() = runBlocking {
		val host = FakeHost()
		val presence = RecordingPresencePort()
		SessionOps(host, presence, MutationJournal(journalDir()))
			.spawnSession("dom.gw.project", "label", "/work", SessionHarness.CLAUDE)

		assertEquals(listOf("dom.gw.project"), host.remembered)
		assertEquals(listOf("dom.gw.project" to SessionHarness.CLAUDE.wire), host.created)
		assertEquals(emptySet<Pair<String, String>>(), host.state.value.pendingSpawns)
		assertEquals(1, presence.refreshes)
	}

	private fun relaunched(harness: String?): FakeHost = runBlocking {
		val host = FakeHost()
		val team = "dom.gw.host.session"
		host.state.value = ChatState(gateways = testRegistry("gw"), teams = listOf(testTeam(team, harness = harness)))
		SessionOps(host, RecordingPresencePort(), MutationJournal(journalDir())).relaunchSession(team)
		host
	}

	@Test
	fun relaunchNamesTheRowsCli() {
		val host = relaunched(SessionHarness.COPILOT.wire)

		assertEquals(listOf("dom.gw.host.session"), host.closed)
		assertEquals(listOf("dom.gw.host" to SessionHarness.COPILOT.wire), host.created)
	}

	@Test
	fun relaunchSendsBackAWordThisAppDoesNotKnowAndTheAssumedCliForARowWithNone() {
		val unknown = relaunched("not-a-cli")

		assertEquals(listOf("dom.gw.host.session"), unknown.closed)
		assertEquals(listOf("dom.gw.host" to "not-a-cli"), unknown.created)
		assertEquals(listOf("dom.gw.host" to UNNAMED_HARNESS.wire), relaunched(null).created)
	}

	@Test
	fun aCliNeverShowsAKeyItExitsOnAndAnUnknownCliHidesNone() {
		val refusing = SessionHarness.OPENCODE
		val shown = sendableKeys(CTRL_MENU_KEYS, HarnessWord.Named(refusing))

		assertTrue(refusing.refusedKeys.isNotEmpty())
		assertTrue(shown.none { (_, key) -> key in refusing.refusedKeys })
		assertEquals(CTRL_MENU_KEYS.size - refusing.refusedKeys.size, shown.size)
		assertEquals(PALETTE_KEYS, sendableKeys(PALETTE_KEYS, HarnessWord.Named(refusing)))
		// Unnamed reads assumed CLI.
		assertEquals(shown, sendableKeys(CTRL_MENU_KEYS, HarnessWord.Unnamed(refusing)))
		assertEquals(CTRL_MENU_KEYS, sendableKeys(CTRL_MENU_KEYS, HarnessWord.Named(SessionHarness.CLAUDE)))
		assertEquals(CTRL_MENU_KEYS, sendableKeys(CTRL_MENU_KEYS, readHarness("not-a-cli")))
	}

	@Test
	fun wakeNamesTheRowsCliPublishesReceiptAndClearRemovesIt() {
		val host = FakeHost()
		host.state.value = host.state.value.copy(teams = listOf(testTeam("dom.gw.host.session", harness = SessionHarness.OPENCODE.wire)))
		val presence = RecordingPresencePort()
		val ops = SessionOps(host, presence, MutationJournal(journalDir()))
		ops.wakeSession("dom.gw.host.session")
		// No row names the assumed CLI.
		ops.wakeSession("dom.gw.host.other")

		assertEquals(
			listOf("dom.gw.host.session" to SessionHarness.OPENCODE.wire, "dom.gw.host.other" to UNNAMED_HARNESS.wire),
			host.wakes,
		)
		assertEquals(2, presence.reapplies)
		val now = System.currentTimeMillis()
		assertEquals(ActionReceipt.Outcome.ACCEPTED, ops.receiptFor("dom.gw.host.session", now)?.outcome)
		ops.clearReceipt("dom.gw.host.session")
		assertNull(ops.receiptFor("dom.gw.host.session", now))
	}

	@Test
	fun forgetCascadesStateCleanupAndGatewayDisposition() {
		val host = FakeHost()
		val team = "dom.gw.host.session"
		host.state.value = ChatState(
			gateways = testRegistry("gw"),
			teams = listOf(testTeam(team)),
			threads = mapOf(team to listOf(Message(false, "hello", 1L))),
			labels = mapOf(team to "label"),
			drafts = mapOf(team to Draft(text = "draft")),
		)
		val dir = journalDir()
		SessionOps(host, IdlePresencePort, MutationJournal(dir)).forget(team, "cancel")

		assertNull(host.state.value.teams.firstOrNull { it.name == team })
		assertNull(host.state.value.threads[team])
		assertNull(host.state.value.labels[team])
		assertNull(host.state.value.drafts[team])
		assertEquals(listOf(team to "cancel"), host.forgotten.map { it.first to it.second })
		assertEquals(1, host.scheduled)
		assertEquals(1, host.goals)
		assertEquals(1, host.playback)
		assertEquals(3, host.persisted)
		// Confirmed: the journal entry goes and the tombstone is the bounded window.
		assertTrue(MutationJournal(dir).entries("forget").isEmpty())
		assertTrue(host.forgottenUntil.getValue(team) < Long.MAX_VALUE)
	}

	@Test
	fun aForgetOnAnotherRosterGatewayJournalsLikeTheHomeOne() {
		val dir = journalDir()
		val host = FakeHost().apply { forgetFails = true }
		host.state.value = ChatState(gateways = testRegistry("gw", "other"))
		SessionOps(host, IdlePresencePort, MutationJournal(dir)).forget("dom.other.host.session", "cancel")

		assertEquals(listOf("dom.other.host.session"), host.forgotten.map { it.first })
		assertEquals(1, MutationJournal(dir).entries("forget").size)
		assertEquals(Long.MAX_VALUE, host.forgottenUntil["dom.other.host.session"])
	}

	@Test
	fun aForgetOnAGatewayTheRosterDoesNotNameTombstonesWithoutJournaling() {
		val dir = journalDir()
		val host = FakeHost()
		host.state.value = ChatState(gateways = testRegistry("other"))
		SessionOps(host, IdlePresencePort, MutationJournal(dir)).forget("dom.gw.host.session")

		assertTrue(host.forgotten.isEmpty())
		assertTrue(MutationJournal(dir).entries("forget").isEmpty())
		assertTrue(host.forgottenUntil.getValue("dom.gw.host.session") < Long.MAX_VALUE)
	}

	@Test
	fun aForgetTheGatewayNeverConfirmedReplaysUnderItsOpIdAfterRestart() {
		val dir = journalDir()
		val team = "dom.gw.host.session"
		val dying = FakeHost().apply { forgetFails = true }
		SessionOps(dying, IdlePresencePort, MutationJournal(dir)).forget(team, "cancel")

		// Held, not the bounded window, while the Gateway still lists it.
		assertEquals(Long.MAX_VALUE, dying.forgottenUntil[team])
		val opId = dying.forgotten.single().third

		// A new process over the same journal.
		val host = FakeHost()
		val ops = SessionOps(host, IdlePresencePort, MutationJournal(dir))
		ops.armPendingForgetTombstones()
		assertEquals(Long.MAX_VALUE, host.forgottenUntil[team])
		runBlocking { ops.replayPendingForgets() }

		assertEquals(listOf(Triple(team, "cancel", opId)), host.forgotten)
		assertTrue(MutationJournal(dir).entries("forget").isEmpty())
		assertTrue(host.forgottenUntil.getValue(team) < Long.MAX_VALUE)
	}

	@Test
	fun aForgetTheRouterAlreadyHoldsOrRefusedRetiresItsJournalEntry() {
		for (outcome in listOf("conflict", "refused")) {
			val dir = journalDir()
			val host = FakeHost().apply { forgetSettled = outcome }
			SessionOps(host, IdlePresencePort, MutationJournal(dir)).forget("dom.gw.host.session", "cancel")

			assertEquals(1, host.forgotten.size)
			assertTrue(MutationJournal(dir).entries("forget").isEmpty())
			assertTrue(host.forgottenUntil.getValue("dom.gw.host.session") < Long.MAX_VALUE)
		}
	}

	@Test
	fun aForgetWithNoGatewayToSendToIsNotJournaled() {
		val dir = journalDir()
		val host = FakeHost()
		SessionOps(host, IdlePresencePort, MutationJournal(dir)).forget("dom.other.host.session")

		assertTrue(host.forgotten.isEmpty())
		assertTrue(MutationJournal(dir).entries("forget").isEmpty())
		assertNotNull(host.forgottenUntil["dom.other.host.session"])
	}
}
