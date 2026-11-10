package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.HarnessSpawns
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.PresencePlane
import com.atelier_nyaarium.switchboard.proto.RosterEntry
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.UNNAMED_HARNESS
import com.atelier_nyaarium.switchboard.proto.readHarness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The CLI pick and macros. */
class SessionHarnessPickTest {
	private val projects = listOf("host", "windows", "recipe-app")

	private fun running(vararg installed: SessionHarness) = SpawnHarnesses(installed.toSet())

	private fun landed(vararg rows: GatewaySpawnPoints): GatewayRegistry =
		GatewayRegistry().landed(
			OwnerPresenceProjection(
				plane = PresencePlane(epoch = 1, version = 1),
				owner = OwnerFacts("d", null, false),
				rows = emptyList(),
				linked = emptyList(),
				roster = rows.map { RosterEntry(it.gatewayId, true, 1, 1) },
				coverage = DiscoverCoverage(rosterKnown = true, asked = 1, answered = 1),
				spawnPoints = rows.toList(),
			),
			RegistryProvenance.Current,
		) { null }

	private fun row(
		gatewayId: String,
		harnessSpawns: HarnessSpawns? = null,
		claudeSpawns: List<String>? = null,
		copilotSpawns: List<String>? = null,
	) = GatewaySpawnPoints(
		gatewayId = gatewayId,
		domainId = "d",
		hostSpawns = listOf("windows"),
		harnessSpawns = harnessSpawns,
		claudeSpawns = claudeSpawns,
		copilotSpawns = copilotSpawns,
	)

	@Test
	fun `a project is offered when its spawn point runs any CLI`() {
		val held: (String) -> SpawnHarnesses = { project ->
			when (project) {
				"recipe-app" -> running(SessionHarness.CLAUDE)
				"windows" -> running(SessionHarness.COPILOT)
				else -> running()
			}
		}

		assertEquals(listOf("windows", "recipe-app"), spawnableProjects(projects, held))
	}

	@Test
	fun `a picked project offers the CLIs its spawn point runs, and keeps the held one when it can`() {
		val all = harnessesOf(running(SessionHarness.COPILOT, SessionHarness.OPENCODE, SessionHarness.CLAUDE))
		val withoutClaude = harnessesOf(running(SessionHarness.COPILOT, SessionHarness.OPENCODE))

		assertEquals(listOf(SessionHarness.CLAUDE, SessionHarness.OPENCODE, SessionHarness.COPILOT), all)
		assertEquals(listOf(SessionHarness.OPENCODE, SessionHarness.COPILOT), withoutClaude)
		assertEquals(SessionHarness.COPILOT, harnessAfterPick(SessionHarness.COPILOT, all))
		assertEquals(SessionHarness.OPENCODE, harnessAfterPick(SessionHarness.CLAUDE, withoutClaude))
		assertNull(harnessAfterPick(SessionHarness.CLAUDE, emptyList()))
	}

	@Test
	fun `each install pair shows where its CLI is, and every pair where none is`() {
		val claude = SessionHarness.CLAUDE.shellMacros
		val copilot = SessionHarness.COPILOT.shellMacros

		assertEquals(claude, shellMacros(running(SessionHarness.CLAUDE)))
		assertEquals(copilot, shellMacros(running(SessionHarness.COPILOT)))
		assertEquals(claude + copilot, shellMacros(running(SessionHarness.CLAUDE, SessionHarness.COPILOT)))
		assertEquals(SessionHarness.entries.flatMap { it.shellMacros }, shellMacros(running()))
	}

	@Test
	fun `a CLI word reads as named, unnamed or unknown, and only an unknown one has no palette`() {
		val named = readHarness(SessionHarness.COPILOT.wire)
		val unnamed = readHarness(null)
		val unknown = readHarness("not-a-cli")

		assertEquals(HarnessWord.Named(SessionHarness.COPILOT), named)
		assertEquals(HarnessWord.Unnamed(UNNAMED_HARNESS), unnamed)
		assertEquals(HarnessWord.Unknown("not-a-cli"), unknown)

		assertEquals(SessionHarness.COPILOT.slashPalette, slashMacros(named))
		assertEquals(UNNAMED_HARNESS.slashPalette, slashMacros(unnamed))
		assertTrue(slashMacros(unknown).isEmpty())
		// No row reads as unnamed.
		assertEquals(unnamed, harnessOf(null))
		assertEquals(named, harnessOf(Team("d.gw.host.s", Presence.ended(), harness = named)))
	}

	@Test
	fun `a devcontainer runs Claude, and an older Gateway reads as Claude on every host spawn point`() {
		val registry = GatewayRegistry()

		assertEquals(running(SessionHarness.CLAUDE), registry.harnessesOn("mikan", "recipe-app"))
		assertEquals(running(SessionHarness.CLAUDE), registry.harnessesOn("mikan", "host"))
		assertEquals(running(SessionHarness.CLAUDE), registry.harnessesOnSession("d.mikan.recipe-app"))
	}

	@Test
	fun `a spawn point's CLIs come from the per-CLI map, and from the two old lists without one`() {
		val registry = landed(
			row(
				"mapped",
				harnessSpawns = HarnessSpawns(
					claude = listOf("windows"),
					opencode = listOf("host"),
					copilot = listOf("host", "windows"),
				),
				claudeSpawns = listOf("host"),
				copilotSpawns = emptyList(),
			),
			row("unprobed", harnessSpawns = HarnessSpawns()),
			row("listed", claudeSpawns = listOf("windows"), copilotSpawns = listOf("host")),
			row("oldest", copilotSpawns = listOf("host")),
		)

		assertEquals(running(SessionHarness.OPENCODE, SessionHarness.COPILOT), registry.harnessesOn("mapped", "host"))
		assertEquals(running(SessionHarness.CLAUDE, SessionHarness.COPILOT), registry.harnessesOn("mapped", "windows"))
		assertEquals(running(), registry.harnessesOn("unprobed", "host"))
		assertEquals(running(SessionHarness.COPILOT), registry.harnessesOn("listed", "host"))
		assertEquals(running(SessionHarness.CLAUDE), registry.harnessesOn("listed", "windows"))
		assertEquals(running(SessionHarness.CLAUDE, SessionHarness.COPILOT), registry.harnessesOn("oldest", "host"))
		assertEquals(running(SessionHarness.CLAUDE), registry.harnessesOn("oldest", "windows"))
		assertEquals(running(SessionHarness.OPENCODE, SessionHarness.COPILOT), registry.harnessesOnSession("d.mapped.host.demo"))
	}
}
