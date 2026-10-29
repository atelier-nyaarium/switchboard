package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantHomeFenceTest {
	private val v3 = AssistantHome.Read(AssistantHomeRecord(3L, "sakura"), null)
	private val v4 = AssistantHome.Read(AssistantHomeRecord(4L, "mikan"), null)
	private val word = AssistantWord.Answered(ConsoleAssistantStateResult(workdir = "~/notes", watchers = emptyList()))

	private fun fence(home: AssistantHome): Triple<AssistantHomeFence, MutableStateFlow<ChatState>, MutableList<AssistantHome.Read>> {
		val state = MutableStateFlow(ChatState(gateways = testRegistry("sakura", "mikan"), assistantHome = home))
		val persisted = mutableListOf<AssistantHome.Read>()
		return Triple(AssistantHomeFence(state, { persisted += it }, {}), state, persisted)
	}

	@Test
	fun anEffectBegunUnderAnOlderChoiceLandsNothingButANewerRecordDoes() {
		val (fence, state, persisted) = fence(v3)
		val before = fence.begin()

		assertEquals(HomeLanding.Landed, fence.land(fence.begin(), HomeEffect.Word("sakura", word)))
		assertEquals(HomeLanding.Landed, fence.land(before, HomeEffect.Record(v4)))

		assertEquals(HomeLanding.Stale, fence.land(before, HomeEffect.Failure("late")))
		assertEquals(HomeLanding.Stale, fence.land(before, HomeEffect.Word("sakura", word)))
		assertNull(state.value.homeFailure)
		// A new choice drops answers given before it.
		assertNull(state.value.gateways.assistantOn("sakura"))
		assertEquals(listOf(v4), persisted)
		assertEquals(HomeLanding.Current, fence.land(fence.begin(), HomeEffect.Record(v3)))
	}

	@Test
	fun aReprovisionStrandsEveryTicketAndRunsInsideTheFence() {
		val (fence, state, persisted) = fence(v3)
		val before = fence.begin()
		var ranUnread = false

		fence.across { ranUnread = state.value.assistantHome == AssistantHome.Unread }

		assertTrue(ranUnread)
		assertEquals(HomeLanding.Stale, fence.land(before, HomeEffect.Record(v4)))
		assertEquals(AssistantHome.Unread, state.value.assistantHome)
		assertTrue(persisted.isEmpty())

		// A ticket cannot be taken mid-provision.
		val entered = CountDownLatch(1)
		val release = CountDownLatch(1)
		val provisioning = thread { fence.across { entered.countDown(); release.await() } }
		entered.await()
		var taken: HomeTicket? = null
		val asking = thread { taken = fence.begin() }
		asking.join(200)
		assertNull(taken)
		release.countDown()
		provisioning.join()
		asking.join()
		assertEquals(2L, taken?.generation)
	}
}
