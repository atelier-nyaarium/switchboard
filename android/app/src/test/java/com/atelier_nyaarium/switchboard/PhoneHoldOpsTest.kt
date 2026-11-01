package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.HoldClaimResult
import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.PhoneHoldPlane
import com.atelier_nyaarium.switchboard.proto.PlaneLineage
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneHoldOpsTest {
	@Test
	fun aClaimAnswerLandsThroughThePlaneFoldAfterTheSendReturns() = runBlocking {
		val hold = PhoneHold("console-key-b", "Pixel", 150L, 2L)
		val lineage = PlaneLineage(2L, 2L)
		val answer = HoldClaimResult(hold, lineage)
		val claimStarted = CompletableDeferred<Unit>()
		val claimAnswer = CompletableDeferred<HoldClaimResult?>()
		val foldStarted = CompletableDeferred<Pair<PlaneLineage, PhoneHoldPlane>>()
		val releaseFold = CompletableDeferred<Unit>()
		val cleared = AtomicInteger()
		val state = MutableStateFlow(ChatState())
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
		val router = object : PhoneHoldRouter {
			override suspend fun claim(): HoldClaimResult? {
				claimStarted.complete(Unit)
				return claimAnswer.await()
			}
		}
		lateinit var ops: PhoneHoldOps
		ops = PhoneHoldOps(
			state = state,
			self = { holdSelf("console-key-a") },
			router = router,
			applyPlane = { incoming, payload ->
				val plane = wireJson.decodeFromJsonElement(PhoneHoldPlane.serializer(), payload)
				foldStarted.complete(incoming to plane)
				releaseFold.await()
				ops.apply(plane.hold)
			},
			pullPlanes = {},
			scope = scope,
			clearSpeech = { cleared.incrementAndGet() },
			now = { 200L },
		)

		try {
			val send = async { ops.beforeSend() }
			withTimeout(2_000L) { claimStarted.await() }
			claimAnswer.complete(answer)
			withTimeout(2_000L) { send.await() }

			val (foldedLineage, foldedPlane) = withTimeout(2_000L) { foldStarted.await() }
			assertEquals(lineage, foldedLineage)
			assertEquals(PhoneHoldPlane(version = hold.version, hold = hold), foldedPlane)
			assertEquals(null, state.value.phoneHold)
			assertEquals(0, cleared.get())

			releaseFold.complete(Unit)
			withTimeout(2_000L) {
				while (cleared.get() == 0) yield()
			}
			assertEquals(hold, state.value.phoneHold)
			assertEquals(1, cleared.get())
		} finally {
			scope.cancel()
		}
	}

	@Test
	fun aClaimAnswerWithoutLineagePullsPlanesWithoutHoldingTheSend() = runBlocking {
		val hold = PhoneHold("console-key-a", "Pixel", 150L, 2L)
		val claimStarted = CompletableDeferred<Unit>()
		val pullStarted = CompletableDeferred<Unit>()
		val releasePull = CompletableDeferred<Unit>()
		val foldCalls = AtomicInteger()
		val state = MutableStateFlow(ChatState())
		val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
		val router = object : PhoneHoldRouter {
			override suspend fun claim(): HoldClaimResult? {
				claimStarted.complete(Unit)
				return HoldClaimResult(hold, null)
			}
		}
		val ops = PhoneHoldOps(
			state = state,
			self = { holdSelf("console-key-a") },
			router = router,
			applyPlane = { _, _ -> foldCalls.incrementAndGet() },
			pullPlanes = {
				pullStarted.complete(Unit)
				releasePull.await()
			},
			scope = scope,
			clearSpeech = {},
			now = { 200L },
		)

		try {
			val send = async { ops.beforeSend() }
			withTimeout(2_000L) { claimStarted.await() }
			withTimeout(2_000L) { send.await() }
			withTimeout(2_000L) { pullStarted.await() }
			assertEquals(null, state.value.phoneHold)
			assertEquals(0, foldCalls.get())
		} finally {
			releasePull.complete(Unit)
			scope.cancel()
		}
	}

	private fun holdSelf(key: String): HoldSelf = HoldSelf.of(
		Crypto.Identity(Crypto.KeyPairRaw(key, ""), Crypto.KeyPairRaw("", "")),
	)
}
