package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RouterSetupTest {
	private class FakeReach(private val answer: () -> Preflight) : ConsoleReach {
		var calls = 0
		override suspend fun preflight(): Preflight {
			calls++
			return answer()
		}
	}

	private class FakeHost : SetupHost {
		val state = MutableStateFlow(ChatState())
		private val writer = RouterLink.Writer(state) { 0L }
		override val router get() = state.value.router
		override fun note(event: RouterEvent) = writer.note(event)

		var root: StepResult = StepResult.Done
		var admission: StepResult = StepResult.Done
		var admissions = 0
		var announced = 0

		override suspend fun firstRoot() = root
		override suspend fun admit(): StepResult {
			admissions++
			return admission
		}
		override fun announce() {
			announced++
		}
		override fun settled() = Unit
		override fun attachIngest() = Unit
		override fun flushIngest() = Unit
	}

	private fun blob(): String = wireJson.encodeToString(
		com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(),
		com.atelier_nyaarium.switchboard.proto.Provisioning(appToken = "token", device = "device"),
	)

	private fun provisioned(): PhoneIdentity {
		val store = testStore()
		return PhoneIdentity(store, FederationManager(store)).also { it.provision(blob()) }
	}

	private val learned = Preflight.Answered(RouterReach(domainId = "learned"))

	@Test
	fun anAnsweringRouterNamesTheDomainAndSettlesOnce() = runBlocking {
		val identity = provisioned()
		assertEquals(BootState.Missing(setOf(Need.DOMAIN_ID)), identity.bootState.value)
		val host = FakeHost()
		val reach = FakeReach { learned }
		val setup = RouterSetup(identity, { reach }, host)

		setup.settle()
		setup.settle()

		assertEquals("learned", identity.readyOrNull()?.domainId)
		assertTrue(host.router.settled)
		assertEquals(1, host.announced)
		assertEquals(1, reach.calls)
	}

	@Test
	fun aSecondCallerWaitsForTheRunInFlightAndThenFindsNothingOwed() = runBlocking {
		val host = FakeHost()
		val gate = CompletableDeferred<Unit>()
		val reach = object : ConsoleReach {
			var calls = 0
			override suspend fun preflight(): Preflight {
				calls++
				gate.await()
				return learned
			}
		}
		val setup = RouterSetup(provisioned(), { reach }, host)

		val first = async(Dispatchers.Default) { setup.settle() }
		val second = async(Dispatchers.Default) { setup.settle() }
		while (reach.calls == 0) delay(1L)
		gate.complete(Unit)

		assertEquals(listOf(true, true), listOf(first.await(), second.await()))
		assertEquals(1, reach.calls)
	}

	@Test
	fun anUnansweredPreflightStaysOwedAndALaterPassSettles() = runBlocking {
		val identity = provisioned()
		val host = FakeHost()
		var unanswered = 2
		val reach = FakeReach { if (unanswered-- > 0) Preflight.Unanswered else learned }
		val setup = RouterSetup(identity, { reach }, host)

		setup.settle()
		assertFalse(host.router.settled)
		assertNull(identity.readyOrNull())
		assertEquals(0, host.admissions)

		setup.settle()
		setup.settle()

		assertTrue(host.router.settled)
		assertEquals(3, reach.calls)
	}

	@Test
	fun aStepThatMustWaitIsTriedAgainAndShowsItsCause() = runBlocking {
		val host = FakeHost().also { it.root = StepResult.Later("clock is off") }
		val reach = FakeReach { learned }
		val setup = RouterSetup(provisioned(), { reach }, host)

		setup.settle()
		assertEquals(Setup.Owed("clock is off"), host.router.setup)
		assertEquals(0, host.admissions)

		host.root = StepResult.Done
		setup.settle()

		assertTrue(host.router.settled)
	}

	@Test
	fun aStepTheRouterRefusedStopsUntilTheOwnerAsksAgain() = runBlocking {
		val host = FakeHost().also { it.admission = StepResult.Refused("rejected") }
		val reach = FakeReach { learned }
		val setup = RouterSetup(provisioned(), { reach }, host)

		setup.settle()
		setup.settle()
		assertEquals(Setup.Refused("rejected"), host.router.setup)
		assertEquals(1, reach.calls)
		assertEquals(0, host.announced)

		host.admission = StepResult.Done
		setup.retry()
		setup.settle()

		assertTrue(host.router.settled)
	}

	@Test
	fun startingOverRunsEveryStepAgain() = runBlocking {
		val host = FakeHost()
		val reach = FakeReach { learned }
		val setup = RouterSetup(provisioned(), { reach }, host)
		setup.settle()

		setup.startOver()
		assertFalse(host.router.settled)
		setup.settle()

		assertTrue(host.router.settled)
		assertEquals(2, host.announced)
	}

	@Test
	fun aRunBegunBeforeSetupStartedOverSettlesNothing() = runBlocking {
		val host = FakeHost()
		lateinit var setup: RouterSetup
		var changes = 1
		val reach = FakeReach {
			// The owner re-provisions mid-run.
			if (changes-- > 0) setup.startOver()
			learned
		}
		setup = RouterSetup(provisioned(), { reach }, host)

		assertFalse(setup.settle())
		assertEquals(Setup.Owed(), host.router.setup)

		assertTrue(setup.settle())
	}

	@Test
	fun aFailureOnThisDeviceStallsWithItsCause() = runBlocking {
		val host = FakeHost()
		val setup = RouterSetup(provisioned(), { throw SecureStorageUnavailable("secure storage unavailable") }, host)

		setup.settle()

		assertEquals(Setup.Owed(localCause(SecureStorageUnavailable("x"))), host.router.setup)
	}

	@Test
	fun aCorruptKeyWaitsOnTheOwner() = runBlocking {
		val host = FakeHost()
		val setup = RouterSetup(provisioned(), { throw IdentityCorrupt("identity corrupt") }, host)

		assertTrue(setup.settle())

		assertEquals(Setup.Refused(localCause(IdentityCorrupt("x"))), host.router.setup)
	}

	@Test
	fun aStepThatThrewNamesItsCauseOnlyWhenNoDoorDid() {
		assertNull(laterOf(java.net.ConnectException("refused")).cause)
		assertNull(laterOf(RouterStatus(503, "restarting")).cause)
		assertNull(laterOf(RouterStatus(401, "Unauthorized")).cause)
		assertEquals(localCause(RouterStatus(400, "invalid enroll op")), laterOf(RouterStatus(400, "invalid enroll op")).cause)
	}

	@Test
	fun anUnprovisionedDeviceNeverReachesTheRouter() = runBlocking {
		val store = testStore()
		val identity = PhoneIdentity(store, FederationManager(store))
		val host = FakeHost()
		val reach = FakeReach { learned }

		RouterSetup(identity, { reach }, host).settle()

		assertEquals(ChatState(), host.state.value)
		assertEquals(0, reach.calls)
	}
}
