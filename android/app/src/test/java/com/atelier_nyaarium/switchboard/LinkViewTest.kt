package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkViewTest {
	private val unreachable = RouterEvent.Missed(Miss.UNREACHABLE)
	private val settled = arrayOf(RouterEvent.Accepted, RouterEvent.SetupSettled)

	private fun view(vararg events: RouterEvent, stepMs: Long = 1_000L): LinkView =
		linkView(ChatState(router = linkAfter(*events, stepMs = stepMs)))

	@Test
	fun aFreshDeviceReadsConnectingUntilSetupSettles() {
		assertEquals(LinkView.Connecting(null), linkView(ChatState()))
		assertEquals(LinkView.Connecting(null), view(RouterEvent.Reached))
		assertEquals(LinkView.Online, view(*settled))
	}

	@Test
	fun aBurstOfMissesReconnectsAndOnlyLastingOnesGoOffline() {
		val cause = missLine(Miss.UNREACHABLE)
		assertEquals(LinkView.Reconnecting(cause), view(*settled, unreachable, unreachable, unreachable, stepMs = 1L))
		assertEquals(LinkView.Offline(cause), view(*settled, unreachable, unreachable, stepMs = DOWN_AFTER_MS))
		assertEquals(LinkView.Online, view(*settled, unreachable, unreachable, RouterEvent.Reached, stepMs = DOWN_AFTER_MS))
	}

	@Test
	fun aRefusalStandsThroughAnswersAndMissesUntilASignedCallIsVerified() {
		val refused = RouterEvent.Refused(Refusal.NOT_ADMITTED)
		val shown = LinkView.Refused(refusalLine(Refusal.NOT_ADMITTED))
		assertEquals(shown, view(*settled, refused))
		assertEquals(shown, view(*settled, refused, RouterEvent.Reached))
		assertEquals(shown, view(*settled, refused, unreachable, unreachable, stepMs = DOWN_AFTER_MS))
		assertEquals(LinkView.Online, view(*settled, refused, RouterEvent.Accepted))
	}

	@Test
	fun notAdmittedIsOrdinaryWhileSetupIsOwedAndARefusalOnceItSettled() {
		val refused = RouterEvent.Refused(Refusal.NOT_ADMITTED)
		assertEquals(LinkView.Connecting(null), view(RouterEvent.Reached, refused))
		// A wrong token blocks setup itself.
		assertEquals(LinkView.Refused(refusalLine(Refusal.TOKEN_REJECTED)), view(RouterEvent.Refused(Refusal.TOKEN_REJECTED)))
		assertEquals(LinkView.Refused(refusalLine(Refusal.NOT_ADMITTED)), view(RouterEvent.Reached, refused, RouterEvent.SetupSettled))
	}

	@Test
	fun theAssistantLandingReadsUnreachableOnlyBeforeSetupSettled() {
		val lasting = arrayOf(unreachable, unreachable)
		val before = ChatState(router = linkAfter(*lasting, stepMs = DOWN_AFTER_MS))
		val after = ChatState(router = linkAfter(*settled, *lasting, stepMs = DOWN_AFTER_MS))
		assertEquals(LinkView.Offline(missLine(Miss.UNREACHABLE)), linkView(after))
		assertEquals(listOf(true, false, false), listOf(before, after, ChatState()).map(::routerUnreachable))
	}

	@Test
	fun setupThatStallsShowsItsCauseAndOneTheRouterRefusedWaitsOnTheOwner() {
		assertEquals(LinkView.Connecting("screen lock"), view(RouterEvent.SetupStalled("screen lock")))
		// An unanswered trip is the nearer cause.
		assertEquals(LinkView.Connecting(missLine(Miss.NO_NETWORK)), view(RouterEvent.SetupStalled("x"), RouterEvent.Missed(Miss.NO_NETWORK)))
		assertEquals(LinkView.Refused("rejected"), view(RouterEvent.Reached, RouterEvent.SetupRefused("rejected")))
		assertEquals(LinkView.Connecting(null), view(*settled, RouterEvent.Refused(Refusal.TOKEN_REJECTED), RouterEvent.SetupOwed))
	}

	@Test
	fun aCurrentRosterWithNoGatewayOffersToAddOne() {
		val online = ChatState(router = onlineLink())
		val none = testRegistry()
		assertEquals(LinkView.NoGateway(awaitingHost = false), linkView(online.copy(gateways = none)))
		assertEquals(LinkView.NoGateway(awaitingHost = true), linkView(online.copy(gateways = none, firstRooted = true)))
		assertEquals(LinkView.Online, linkView(online.copy(gateways = testRegistry("sakura"))))
		// A cached roster proves nothing.
		assertEquals(LinkView.Online, linkView(online.copy(gateways = testRegistry(provenance = RegistryProvenance.Cached))))
		assertEquals(LinkView.Connecting(null), linkView(ChatState(gateways = none)))
	}

	@Test
	fun aConversationShowsANoticeFirstAndHidesAPassingCauseWhileItWakes() {
		val offline = LinkView.Offline("down")
		assertEquals("notice", threadBanner("notice", offline, waking = false))
		assertEquals("down", threadBanner(null, offline, waking = false))
		assertNull(threadBanner(null, offline, waking = true))
		assertEquals("re-run setup", threadBanner(null, LinkView.Refused("re-run setup"), waking = true))
		assertNull(threadBanner(null, LinkView.Reconnecting("blip"), waking = false))
	}

	@Test
	fun aThrownCallIsWordedByItsType() {
		assertEquals(refusalLine(Refusal.TOKEN_REJECTED), failureLine(RouterStatus(401, "Unauthorized")))
		assertEquals(missLine(Miss.NO_NETWORK), failureLine(java.net.UnknownHostException("router")))
		assertEquals(true, failureLine(IllegalStateException("send failed: no holder")).contains("no holder"))
	}
}
