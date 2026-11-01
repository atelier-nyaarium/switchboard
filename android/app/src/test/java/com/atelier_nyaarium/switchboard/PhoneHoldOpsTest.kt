package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.PhoneHoldPlane
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneHoldOpsTest {
	private class ClaimRouter(private val laterHold: PhoneHold) : PhoneHoldRouter {
		val firstStarted = CompletableDeferred<Unit>()
		val staleAnswer = CompletableDeferred<PhoneHold?>()
		val laterStarted = CompletableDeferred<Unit>()
		private val claims = AtomicInteger()
		val claimCount: Int get() = claims.get()

		override suspend fun claim(): PhoneHold? = when (claims.incrementAndGet()) {
			1 -> {
				firstStarted.complete(Unit)
				staleAnswer.await()
			}
			2 -> {
				laterStarted.complete(Unit)
				laterHold
			}
			else -> error("Unexpected claim")
		}

		override suspend fun read(): PhoneHoldPlane? = null
	}

	@Test
	fun aStaleClaimAnswerDoesNotSuppressALaterConversationClaim() = runBlocking {
		val otherHold = PhoneHold("console-key-b", "Pixel", 150L, 2L)
		val laterHold = PhoneHold("console-key-a", "Pixel", 190L, 3L)
		val router = ClaimRouter(laterHold)
		val state = MutableStateFlow(ChatState())
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
		val ops = PhoneHoldOps(
			state = state,
			self = { HoldSelf.fromConsoleSigningKey("console-key-a") },
			router = router,
			scope = scope,
			clearSpeech = {},
			now = { 200L },
		)

		try {
			ops.onConversationShown("team")
			withTimeout(2_000L) { router.firstStarted.await() }
			val firstClaim = checkNotNull(scope.coroutineContext[Job]).children.single()

			ops.apply(otherHold, 2L)
			router.staleAnswer.complete(PhoneHold("console-key-a", "Pixel", 100L, 1L))
			withTimeout(2_000L) { firstClaim.join() }

			ops.onConversationShown("team")
			withTimeout(2_000L) { router.laterStarted.await() }
			withTimeout(2_000L) {
				while (state.value.phoneHold?.version != laterHold.version) yield()
			}

			assertEquals(2, router.claimCount)
			assertEquals(laterHold, state.value.phoneHold)
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun anOlderOwnClaimAnswerLeavesTheNewerHoldAndClaimState() = runBlocking {
		val newerHold = PhoneHold("console-key-b", "Pixel", 150L, 2L)
		val olderOwnAnswer = PhoneHold("console-key-a", "Pixel", 100L, 1L)
		val claims = AtomicInteger()
		val router = object : PhoneHoldRouter {
			override suspend fun claim(): PhoneHold? {
				claims.incrementAndGet()
				return null
			}

			override suspend fun read(): PhoneHoldPlane? = null
		}
		val state = MutableStateFlow(ChatState())
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
		val ops = PhoneHoldOps(
			state = state,
			self = { HoldSelf.fromConsoleSigningKey("console-key-a") },
			router = router,
			scope = scope,
			clearSpeech = {},
			now = { 200L },
		)

		try {
			ops.apply(newerHold, 2L)
			assertEquals(false, ops.apply(olderOwnAnswer, 1L, ownClaimAnswer = true))
			assertEquals(newerHold, state.value.phoneHold)

			ops.onConversationShown("team")
			withTimeout(2_000L) {
				while (claims.get() != 2) yield()
			}
			assertEquals(2, claims.get())
		} finally {
			scope.cancel()
		}
	}
}
