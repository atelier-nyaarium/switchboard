package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GoalOpsTest {
	private class FakeSessions(private val state: MutableStateFlow<ChatState>) : GoalOpsCollaborators {
		val sends = mutableListOf<String>()
		val typed = mutableListOf<Pair<String?, String?>>()
		override suspend fun send(team: String, text: String, files: List<MessageFile>): String {
			sends += text
			state.value = state.value.copy(threads = mapOf(team to listOf(Message(true, text, 1L, status = "pending", opId = "op"))))
			return "op"
		}
		override suspend fun peekTerminal(team: String) = Result.success(ConsolePeekResult(kind = "tmux", hash = "h", ansi = "Claude Code\n❯ "))
		override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) { typed += text to key }
	}

	private val team = "local.gw.host.session"

	/** Null seeds no row. */
	private fun opsOver(harness: SessionHarness?): Triple<GoalOps, FakeSessions, MutableStateFlow<ChatState>> {
		val teams = harness?.let { listOf(testTeam(team, harness = it.wire)) }.orEmpty()
		val state = MutableStateFlow(ChatState(teams = teams))
		val fake = FakeSessions(state)
		val ops = GoalOps(state, ChatPersistence(testStore()) { state.value }, CoroutineScope(Dispatchers.Unconfined), fake)
		return Triple(ops, fake, state)
	}

	@Test
	fun armPersistsTheGoalAndDrivesTheTerminal() = runBlocking {
		// No row reads as unnamed.
		for (harness in listOf(SessionHarness.CLAUDE, null)) {
			val (ops, fake, state) = opsOver(harness)

			assertTrue(ops.armAndSend(team, "  ship  it ", "message", emptyList()))

			assertEquals("message", fake.sends.single())
			assertEquals(listOf("/goal ", "ship it", null), fake.typed.map { it.first })
			assertEquals(emptyMap<String, PendingGoal>(), state.value.goals)
		}
	}

	@Test
	fun aCliWithoutTheCommandIsArmedNothingAndSentNothing() = runBlocking {
		val (ops, fake, state) = opsOver(SessionHarness.OPENCODE)

		assertFalse(ops.armAndSend(team, "ship it", "message", emptyList()))

		assertTrue(fake.sends.isEmpty())
		assertTrue(fake.typed.isEmpty())
		assertEquals(emptyMap<String, PendingGoal>(), state.value.goals)
		assertNotNull(state.value.error)
	}
}
