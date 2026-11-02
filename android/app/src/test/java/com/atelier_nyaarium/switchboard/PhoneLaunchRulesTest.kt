package com.atelier_nyaarium.switchboard

import android.provider.AlarmClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneLaunchRulesTest {
	@Test
	fun mapsSchemesEncodeSpacesAndSymbols() {
		assertEquals("geo:0,0?q=Main%20St%20%26%202nd", mapsUri("Main St & 2nd", false))
		assertEquals("google.navigation:q=A%2FB%20%26%20C%3F", mapsUri(" A/B & C? ", true))
	}

	@Test
	fun appMatchesTrimmedCaseInsensitiveLabelsAndPackages() {
		assertTrue(appMatches("Mail Client", "org.example.mail", " MAIL "))
		assertTrue(appMatches("Mail Client", "org.example.mail", "EXAMPLE.MAIL"))
		assertTrue(appMatches("Mail Client", "org.example.mail", "  "))
		assertFalse(appMatches("Mail Client", "org.example.mail", "chat"))
		assertFalse(appMatches("Mail Client", "org.example.mail", "x".repeat(81)))
	}

	@Test
	fun appResolutionDistinguishesOneSeveralNoneAndABlankQuery() {
		val one = AppCandidate("Mail Client", "org.example.mail")
		assertEquals(AppResolution.One("org.example.mail"), resolveApp(listOf(one), "mail"))
		assertEquals(AppResolution.None, resolveApp(listOf(one), "calendar"))
		assertEquals(AppResolution.None, resolveApp(listOf(one), "  "))

		val many = (1..12).map { AppCandidate("Mail $it", "org.example.mail$it") }
		val several = resolveApp(many, "mail") as AppResolution.Several
		assertEquals(10, several.candidates.size)
		assertEquals(AppCandidate("Mail 1", "org.example.mail1"), several.candidates.first())
	}

	@Test
	fun alarmAndTimerExtrasCarryBoundedValuesAndSkipUi() {
		val alarm = alarmExtras(7L, 35L, "Wake up")
		assertTrue(LaunchExtra.IntExtra(AlarmClock.EXTRA_HOUR, 7) in alarm)
		assertTrue(LaunchExtra.IntExtra(AlarmClock.EXTRA_MINUTES, 35) in alarm)
		assertTrue(LaunchExtra.TextExtra(AlarmClock.EXTRA_MESSAGE, "Wake up") in alarm)
		assertTrue(LaunchExtra.FlagExtra(AlarmClock.EXTRA_SKIP_UI, true) in alarm)

		val clamped = alarmExtras(30L, 70L, null)
		assertTrue(LaunchExtra.IntExtra(AlarmClock.EXTRA_HOUR, 23) in clamped)
		assertTrue(LaunchExtra.IntExtra(AlarmClock.EXTRA_MINUTES, 59) in clamped)
		assertTrue(clamped.none { it.key == AlarmClock.EXTRA_MESSAGE })

		val timer = timerExtras(90L, "Tea")
		assertTrue(LaunchExtra.IntExtra(AlarmClock.EXTRA_LENGTH, 90) in timer)
		assertTrue(LaunchExtra.TextExtra(AlarmClock.EXTRA_MESSAGE, "Tea") in timer)
		assertTrue(LaunchExtra.FlagExtra(AlarmClock.EXTRA_SKIP_UI, true) in timer)
		assertTrue(LaunchExtra.IntExtra(AlarmClock.EXTRA_LENGTH, 86_400) in timerExtras(Long.MAX_VALUE, null))
	}
}
