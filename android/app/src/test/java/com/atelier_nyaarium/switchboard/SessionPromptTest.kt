package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.SessionPrompt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionPromptTest {
	private val team = "dom.gw.proj.main"
	private val prompt = SessionPrompt(id = "p1", title = "Bash command", body = listOf("rm -f out/x"))

	private fun promptJson(id: String) = JsonObject(
		mapOf(
			"prompt" to JsonObject(
				mapOf(
					"id" to JsonPrimitive(id),
					"title" to JsonPrimitive("Bash command"),
					"body" to JsonArray(listOf(JsonPrimitive("rm -f out/x"))),
				),
			),
		),
	)

	private fun outcome(word: String) = ConsoleClient.ValueAnswer.Answered(JsonObject(mapOf("outcome" to JsonPrimitive(word))))

	@Test
	fun `only an online session's prompt waits, and the panel hides once settled`() {
		val state = ChatState(
			teams = listOf(
				testTeam(team, promptId = "p1"),
				testTeam("dom.gw.proj.asleep", status = Presence.AVAILABLE, promptId = "p2"),
				testTeam("dom.gw.proj.idle"),
			),
		)
		assertEquals(mapOf(team to "p1"), waitingPrompts(state))

		val loading = approvalView("p1", emptyMap(), emptyMap())
		assertFalse(loading!!.answerable)
		val shown = approvalView("p1", mapOf("p1" to prompt), emptyMap())!!
		assertTrue(shown.answerable)
		assertFalse(denyReady(shown, "   "))
		assertTrue(denyReady(shown, "use rm out/a.tmp instead"))
		assertNull(approvalView("p1", mapOf("p1" to prompt), mapOf("p1" to PromptAnswerState.Settled)))
		assertNull(approvalView(null, mapOf("p1" to prompt), emptyMap()))
	}

	@Test
	fun `a notice posts once per prompt id, waits out a phone that does not alert, and leaves with its session`() {
		val waiting = mapOf("a" to "p1")
		val muted = promptNotices(emptyMap(), waiting, alerts = false)
		assertEquals(emptyList<String>(), muted.post)
		var posted = postedAfter(emptyMap(), waiting, muted, emptyList())

		val first = promptNotices(posted, waiting, alerts = true)
		assertEquals(listOf("a"), first.post)
		posted = postedAfter(posted, waiting, first, listOf("a"))
		assertEquals(emptyList<String>(), promptNotices(posted, waiting, alerts = true).post)

		val failed = promptNotices(posted, mapOf("a" to "p2"), alerts = true)
		posted = postedAfter(posted, mapOf("a" to "p2"), failed, emptyList())
		assertEquals(listOf("a"), promptNotices(posted, mapOf("a" to "p2"), alerts = true).post)

		assertEquals(listOf("a"), promptNotices(mapOf("a" to "p1"), emptyMap(), alerts = true).cancel)
		assertEquals(listOf("a"), promptNotices(mapOf("a" to "p1"), waiting, alerts = false).cancel)
	}

	@Test
	fun `an answer is forgotten once no session waits on it, so the same prompt can show again`() = runBlocking {
		val ops = SessionPromptOps { _, _ -> outcome("answered") }
		ops.answer("gw", team, "p1", PromptDecision.APPROVE, null)
		assertNull(approvalView("p1", emptyMap(), ops.answers.value))
		ops.retain(listOf("p1"))
		assertNull(approvalView("p1", emptyMap(), ops.answers.value))
		ops.retain(emptyList())
		assertTrue(approvalView("p1", emptyMap(), ops.answers.value) != null)
	}

	@Test
	fun `answered and stale both settle, and a refusal keeps its words`() {
		assertEquals(PromptAnswerState.Settled, answerStateOf(outcome("answered")))
		assertEquals(PromptAnswerState.Settled, answerStateOf(outcome("stale")))
		assertEquals(
			PromptAnswerState.Failed("the prompt is still waiting"),
			answerStateOf(ConsoleClient.ValueAnswer.Refused("the prompt is still waiting")),
		)
		assertTrue(answerStateOf(ConsoleClient.ValueAnswer.Unreachable) is PromptAnswerState.Failed)
	}

	@Test
	fun `an answer goes once while in flight, and a deny never goes without a steer`() = runBlocking {
		val sent = mutableListOf<ConsoleOp>()
		val gate = CompletableDeferred<Unit>()
		val ops = SessionPromptOps { _, op ->
			sent += op
			gate.await()
			outcome("answered")
		}
		ops.answer("gw", team, "p1", PromptDecision.DENY, "  ")
		assertTrue(sent.isEmpty())

		val first = async { ops.answer("gw", team, "p1", PromptDecision.DENY, " use rm instead ") }
		yield()
		assertEquals(PromptAnswerState.Sending, ops.answers.value["p1"])
		ops.answer("gw", team, "p1", PromptDecision.APPROVE, null)
		gate.complete(Unit)
		first.await()

		assertEquals(listOf<ConsoleOp>(ConsoleOp.SessionPromptAnswer(team, "p1", PromptDecision.DENY, "use rm instead")), sent)
		assertEquals(PromptAnswerState.Settled, ops.answers.value["p1"])
		ops.answer("gw", team, "p1", PromptDecision.APPROVE, null)
		assertEquals(1, sent.size)
	}

	@Test
	fun `a failed answer can be sent again`() = runBlocking {
		var calls = 0
		val ops = SessionPromptOps { _, _ ->
			calls++
			if (calls == 1) ConsoleClient.ValueAnswer.Unreachable else outcome("answered")
		}
		ops.answer("gw", team, "p1", PromptDecision.APPROVE, null)
		assertTrue(ops.answers.value["p1"] is PromptAnswerState.Failed)
		ops.answer("gw", team, "p1", PromptDecision.APPROVE, null)
		assertEquals(PromptAnswerState.Settled, ops.answers.value["p1"])
	}

	@Test
	fun `a prompt's text is held by its own id`() = runBlocking {
		val ops = SessionPromptOps { _, op ->
			assertEquals(ConsoleOp.SessionPrompt(team), op)
			ConsoleClient.ValueAnswer.Answered(promptJson("p1"))
		}
		ops.keepLoaded("gw", team, "p1")
		assertEquals(prompt, ops.prompts.value["p1"])
	}
}
