package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CliPick
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.UNPICKED_WORD
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CliPickRulesTest {
	private val claude = SessionHarness.CLAUDE
	private val opencode = SessionHarness.OPENCODE
	private val copilot = SessionHarness.COPILOT

	private fun known(vararg installed: SessionHarness) = SpawnHarnesses.Known(installed.toSet())

	@Test
	fun theTogglesOfferWhatTheSpawnPointRunsAndWhatAnUnopenedContainerAllows() {
		assertEquals(listOf(CliChoice("opencode", "OpenCode"), CliChoice("copilot", "Copilot")), cliChoices(known(copilot, opencode), shown = null))
		assertEquals(
			SessionHarness.entries.filter { it.containers }.map { it.wire },
			cliChoices(SpawnHarnesses.UNOPENED_CONTAINER, shown = null).map { it.wire },
		)
		assertEquals(emptyList<CliChoice>(), cliChoices(known(), shown = null))
	}

	@Test
	fun aShownPickTheSpawnPointNoLongerRunsStaysFirstAndMarked() {
		assertEquals(
			listOf(CliChoice("claude", "Claude", offered = false), CliChoice("copilot", "Copilot")),
			cliChoices(known(copilot), shown = "claude"),
		)
		// A newer CLI shows as its word.
		assertEquals(CliChoice("newer-cli", "newer-cli", offered = false), cliChoices(known(claude), shown = "newer-cli").first())
	}

	@Test
	fun aHeldWordReadsAsAPickNoneOrUnreadable() {
		assertEquals(CliPick.Picked(copilot), pickOf("copilot"))
		assertEquals(CliPick.Unpicked, pickOf(UNPICKED_WORD))
		assertEquals(CliPick.Unpicked, pickOf(null))
		assertNull(pickOf("newer-cli"))
		assertEquals("newer-cli", shownPick(null, unread = "newer-cli"))
		assertNull(shownPick(CliPick.Unpicked, unread = null))
	}

	@Test
	fun aTapPicksAndATapOnTheShownOneClearsIt() {
		assertEquals(CliPick.Picked(opencode), pickAfterTap(CliPick.Unpicked, null, "opencode"))
		assertEquals(CliPick.Picked(copilot), pickAfterTap(CliPick.Picked(opencode), null, "copilot"))
		assertEquals(CliPick.Unpicked, pickAfterTap(CliPick.Picked(opencode), null, "opencode"))
		assertEquals(CliPick.Unpicked, pickAfterTap(null, "newer-cli", "newer-cli"))
		assertEquals(CliPick.Picked(claude), pickAfterTap(null, "newer-cli", "claude"))
	}

	@Test
	fun aFreshPickIsNewSessionsDefault() {
		assertEquals(CliPick.Picked(claude), freshPick(SpawnHarnesses.UNOPENED_CONTAINER))
		assertEquals(CliPick.Picked(opencode), freshPick(known(copilot, opencode)))
		assertEquals(CliPick.Unpicked, freshPick(known()))
	}
}
