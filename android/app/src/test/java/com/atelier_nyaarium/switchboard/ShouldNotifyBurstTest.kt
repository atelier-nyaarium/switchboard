package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PhoneHold
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShouldNotifyBurstTest {
	private val team = "alice.sakura.coollib.main"
	private val self = HoldSelf.fromConsoleSigningKey("console-key-a")

	@Test
	fun firesWhenBackgroundedNotifiableAndUnmuted() {
		assertTrue(shouldNotifyBurst(false, true, emptySet(), team, null, self))
	}

	@Test
	fun suppressedWhileTheActivityIsVisible() {
		assertFalse(shouldNotifyBurst(true, true, emptySet(), team, null, self))
	}

	@Test
	fun suppressedWhenNotificationsAreUnavailable() {
		assertFalse(shouldNotifyBurst(false, false, emptySet(), team, null, self))
	}

	@Test
	fun anExplicitlyClosedTeamIsSuppressed() {
		assertFalse(shouldNotifyBurst(false, true, setOf(team), team, null, self))
	}

	@Test
	fun closingADifferentTeamDoesNotMuteThisOne() {
		assertTrue(shouldNotifyBurst(false, true, setOf("alice.sakura.other.main"), team, null, self))
	}

	@Test
	fun anotherStandingHolderSuppressesTheBurst() {
		val hold = PhoneHold(holder = "console-key-b", label = "Pixel", claimedAt = 100L, version = 1L)
		assertFalse(shouldNotifyBurst(false, true, emptySet(), team, hold, self, 200L))
	}

	@Test
	fun theHoldingPhoneStillFollowsTheExistingGate() {
		val hold = PhoneHold(holder = "console-key-a", label = "Pixel", claimedAt = 100L, version = 1L)
		assertTrue(shouldNotifyBurst(false, true, emptySet(), team, hold, self, 200L))
	}

	@Test
	fun reconcileLeavesANotShowingTeamAlone() {
		assertEquals(TeamNotificationAction.LEAVE, teamNotificationAction(false, 1, false, false))
	}

	@Test
	fun reconcileSilentlyRefreshesAShowingUnreadTeam() {
		assertEquals(TeamNotificationAction.SILENT_REFRESH, teamNotificationAction(true, 2, false, false))
	}

	@Test
	fun reconcileCancelsWhenAnotherPhonesAnchorClearsUnread() {
		assertEquals(TeamNotificationAction.CANCEL, teamNotificationAction(true, 0, false, false))
	}

	@Test
	fun reconcileCancelsAShowingNotificationForAnotherHolder() {
		assertEquals(TeamNotificationAction.CANCEL, teamNotificationAction(true, 2, true, false))
	}

	@Test
	fun reconcileCancelsAClosedShowingTeam() {
		assertEquals(TeamNotificationAction.CANCEL, teamNotificationAction(true, 2, false, true))
	}
}
