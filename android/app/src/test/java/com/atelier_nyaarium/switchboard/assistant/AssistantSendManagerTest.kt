package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantSendIntent
import com.atelier_nyaarium.switchboard.proto.AssistantSendRequest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantSendManagerTest {
	private class RefusingStore : AssistantSendStore {
		var raw: String? = null
		var refuse = false

		override fun loadAssistantSends(): String? = raw

		override fun saveAssistantSends(json: String) {
			if (refuse) error("disk full")
			raw = json
		}
	}

	@Test
	fun aReprovisionDropsHeldCardsEvenWhenTheDiskRefuses() = runBlocking {
		val store = RefusingStore()
		val manager = AssistantSendManager(store)
		val request = AssistantSendRequest(
			v = 1L,
			requestId = "send-1",
			sessionTarget = "host.assistant",
			deadlineAt = System.currentTimeMillis() + 60_000L,
			intent = AssistantSendIntent(target = "home.sakura.host.w", body = "b", createsSession = false, files = emptyList()),
		)
		manager.onRequest("sakura", "host.assistant", request)
		val held = manager.pending.value.size
		store.refuse = true

		manager.clearInMemory()

		assertEquals(listOf(1, 0), listOf(held, manager.pending.value.size))
	}
}
