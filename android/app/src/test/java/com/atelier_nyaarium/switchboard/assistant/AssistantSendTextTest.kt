package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantSendFile
import com.atelier_nyaarium.switchboard.proto.AssistantSendIntent
import com.atelier_nyaarium.switchboard.proto.AssistantSendRequest
import com.atelier_nyaarium.switchboard.vault.VaultTile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class AssistantSendTextTest {
	private fun request(intent: AssistantSendIntent) =
		AssistantSendRequest(v = 1L, requestId = "send-1", sessionTarget = "host.assistant", deadlineAt = 7_200_000L, intent = intent)

	@Test
	fun theCardShowsEveryBoundFieldAndTheWholeBody() {
		val card = assistantSendCardText(
			request(
				AssistantSendIntent(
					target = "friend.sakura.host.claude",
					friendDomain = "friend",
					body = "Exact body\nSecond line",
					disposition = "informing",
					displayLabel = "Release notes",
					createsSession = true,
					files = listOf(AssistantSendFile("sha256-0123456789abcdef", "notes.md", "text/markdown", 42L)),
				),
			),
			now = 0L,
		)

		assertEquals(
			listOf(
				"To: friend.sakura.host.claude",
				"Friend Domain: friend",
				"Disposition: informing",
				"Label: Release notes",
				"Creates the session if absent: yes",
			),
			card.fields,
		)
		assertEquals(listOf("notes.md (text/markdown), 42 bytes, sha256-0123456789abcdef"), card.files)
		assertEquals("Exact body\nSecond line", card.body)
		assertEquals("Expires in 2 h", card.expiry.text)
	}

	@Test
	fun anOmittedDispositionReadsAsAsking() {
		val card = assistantSendCardText(
			request(AssistantSendIntent(target = "home.sakura.host.w", body = "b", createsSession = false, files = emptyList())),
			now = 0L,
		)

		assertEquals("Disposition: asking", card.fields[1])
	}

	@Test
	fun theConversationTileShowsThisGatewaysOldestSendByLabelAndFirstLine() {
		fun waiting(gatewayId: String, id: String, deadlineAt: Long, intent: AssistantSendIntent) =
			PendingAssistantSend(gatewayId, "host.assistant", request(intent).copy(requestId = id, deadlineAt = deadlineAt))
		val ops = AssistantSendIntent(
			target = "home.sakura.host.github-ops",
			body = "\nHi, I'm the owner's assistant.\nThe PRs",
			displayLabel = "GitHub Ops",
			createsSession = true,
			files = emptyList(),
		)
		val plain = AssistantSendIntent(target = "home.sakura.host.w", body = "b", createsSession = false, files = emptyList())

		val tile = assistantSendTile(
			listOf(waiting("sakura", "late", 9L, plain), waiting("ume", "other", 1L, plain), waiting("sakura", "early", 3L, ops)),
			"sakura",
		)

		assertEquals(
			VaultTile("early", "${AssistantSendWords.TITLE} (+1)", "To GitHub Ops, a new session", "Hi, I'm the owner's assistant.", 3L),
			tile,
		)
		assertEquals("To home.sakura.host.w", assistantSendTile(listOf(waiting("sakura", "only", 9L, plain)), "sakura")?.requester)
		assertNull(assistantSendTile(listOf(waiting("ume", "other", 1L, plain)), "sakura"))
	}

	@Test
	fun thePublicNotificationNamesNoTargetAndNoText() {
		val public = assistantSendPublicNotificationText()

		assertFalse(public.contains("sakura"))
		assertEquals(AssistantSendWords.TITLE, public)
	}
}
