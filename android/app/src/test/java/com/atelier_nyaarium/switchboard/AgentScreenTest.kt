package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors the tmuxCore isAgentReady/isAgentWorking markers so the chip and the daemon agree. */
class AgentScreenTest {
	@Test
	fun ready() {
		assertEquals(false, AgentScreen.isReady(""))
		assertEquals(false, AgentScreen.isReady("Loading development channels..."))
		// An indented menu cursor is the dev-channels prompt, not the composer.
		assertEquals(false, AgentScreen.isReady("  ❯ 1. I am using this for local development"))
		assertEquals(true, AgentScreen.isReady("Claude Code v2.1.0\n❯ "))
		// A resumed session whose header scrolled off still shows the composer.
		assertEquals(true, AgentScreen.isReady("...restored conversation...\n❯ "))
	}

	@Test
	fun working() {
		// The "esc to interrupt" hint in the bottom status line means working.
		assertEquals(true, AgentScreen.isWorking("✻ Prestidigitating… (12s · esc to interrupt)"))
		// It can land on either of the last two lines depending on how the pane wraps.
		assertEquals(true, AgentScreen.isWorking("✻ Prestidigitating…\n(12s · esc to interrupt)"))
		assertEquals(true, AgentScreen.isWorking("(12s · esc to interrupt)\n✻ Prestidigitating…"))
		// A settled "✻ Brewed for Ns" line with no hint, or no hint at all, is not working.
		assertEquals(false, AgentScreen.isWorking("✻ Brewed for 7s"))
		assertEquals(false, AgentScreen.isWorking(""))
		assertEquals(false, AgentScreen.isWorking("Claude Code v2.1.0\n❯ "))
		// A line more than two back does not count - ONLY absent a rule to bound the search by; see
		// findsTheWorkingHintAnyDistanceBelowTheRule below for the same distance with a rule present.
		assertEquals(false, AgentScreen.isWorking("(12s · esc to interrupt)\n● Done.\n❯ "))
	}

	@Test
	fun workingHintBoundedByTheRuleRatherThanAFixedLineCount() {
		val rule = "─".repeat(40)
		// The footer's height is dynamic (terminal width/wrapping): the hint sits 3 lines above the
		// very bottom here, past the old fixed "last 2 lines" heuristic, but it IS below the rule, so
		// the properly-bounded footer search still finds it.
		assertEquals(
			true,
			AgentScreen.isWorking(
				"❯ \n$rule\n✻ Prestidigitating… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on\n  ← for agents",
			),
		)
		// A hint ABOVE the rule is transcript/history, not the live footer - never counts, even when
		// it would fall within some arbitrary distance of the bottom.
		assertEquals(
			false,
			AgentScreen.isWorking("● It said (12s · esc to interrupt)\n$rule\n❯ "),
		)
	}

	@Test
	fun aSpinnerAndItsVerbReadWorkingAndAFinishedTurnReadsIdle() {
		val rule = "─".repeat(40)
		val pane = { status: String -> "$status\n$rule\n❯ \n$rule\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · …" }
		assertEquals(true, AgentScreen.isWorking(pane("✢ Cogitating…")))
		assertEquals(true, AgentScreen.isWorking(pane("* Calling plugin:switchboard:switchboard…")))
		assertEquals(false, AgentScreen.isWorking(pane("✻ Churned for 2h 6m 20s · done 3:31 PM")))
		assertEquals(false, AgentScreen.isWorking(pane("● Bash(cd /tmp/claude-1000/kit && rm -f out/…)")))
		assertEquals(false, AgentScreen.isWorking(pane("  ✔ Update installed · Restart…")))
		assertEquals(false, AgentScreen.isWorking(pane("\n  ✔ Update installed · Restart…")))
		assertEquals(false, AgentScreen.isWorking(pane("❯ please check the logs…")))
		assertEquals(false, AgentScreen.isWorking(pane("- fix the thing…")))
	}

	@Test
	fun compactingReadsThroughAWrappedTipButNotFromFarUpTheTranscript() {
		val rule = "─".repeat(40)
		val tip = "  ⎿  Tip: Run claude --continue or\n     claude --resume to resume a\n     conversation"
		val pane = { above: String -> "$above· Compacting conversation… (10s)\n$tip\n   0% until auto-compact\n$rule\n❯ \n$rule" }
		assertEquals(true, AgentScreen.isCompacting(pane("")))
		assertEquals(false, AgentScreen.isCompacting(pane("").replace("Compacting", "Composing")))
		assertEquals(false, AgentScreen.isCompacting(pane("").replace(tip, "$tip\n\n\n\n")))
	}

	@Test
	fun aTeammateBelowTheToolbarReadsWorkingUntilItsRowSaysIdle() {
		val rule = "─".repeat(40)
		val crew = { rows: String -> "❯ \n$rule\n  ⏵⏵ bypass permissions on · ↓ to manage\n  ● main\n$rows" }
		assertEquals(true, AgentScreen.isWorking(crew("  ◯ ieee  IEEE 754… 15s · ↓ 191.5k tokens")))
		assertEquals(true, AgentScreen.isWorking(crew("  ◯ ieee  IEEE 754 subnormals 1s")))
		// Viewing the teammate swaps the dots.
		assertEquals(true, AgentScreen.isWorking("❯ \n$rule\n  ◯ main\n  ● ieee  IEEE 754… 15s"))
		assertEquals(false, AgentScreen.isWorking(crew("  ◯ ieee  IEEE 754 subnormals                idle")))
		assertEquals(false, AgentScreen.isWorking(crew("  ◯ red-team  ▰▰▰▰▰▰  6/6")))
		assertEquals(false, AgentScreen.isWorking(crew("")))
		// Above the composer is transcript.
		assertEquals(false, AgentScreen.isWorking("  ◯ ieee  IEEE 754… 15s\n$rule\n❯ "))
	}

	/**
	 * The status line a running turn draws ABOVE the composer, which is where the CLI puts it now. The
	 * footer alone cannot answer it: the toolbar elides the esc hint when the pane is too narrow, and
	 * the mode label counts toward that width.
	 */
	@Test
	fun statusLineAboveTheComposerCountsWhenTheFooterHintIsElided() {
		val rule = "─".repeat(40)
		val toolbar = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · …"
		assertEquals(true, AgentScreen.isWorking("✶ Composing… (46m 51s · ↓ 154.1k tokens)\n$rule\n❯ \n$rule\n$toolbar"))
		assertEquals(false, AgentScreen.isWorking("● Done.\n$rule\n❯ \n$rule\n$toolbar"))
	}

	// Bounded on purpose. Far enough above the composer is transcript, and a transcript can quote
	// anything, including a pane.
	@Test
	fun aStatusLineFarUpTheTranscriptIsNotRead() {
		val rule = "─".repeat(40)
		val far = "✶ Composing… (1m 2s · ↓ 9k tokens)\n\n\n\n\n\n\n$rule\n❯ "
		assertEquals(false, AgentScreen.isWorking(far))
	}

	@Test
	fun loggedOut() {
		val rule = "─".repeat(40)
		// Auth footer in the toolbar below the last rule.
		assertEquals(
			true,
			AgentScreen.isLoggedOut("❯ \n$rule\n  ⏵⏵ bypass permissions on · ← for agents    Not logged in · Run /login"),
		)
		// Logged in: no auth footer.
		assertEquals(false, AgentScreen.isLoggedOut("❯ \n$rule\n  ⏵⏵ bypass permissions on · ← for agents"))
		// The phrase above the last rule (transcript or composer) does not count.
		assertEquals(
			false,
			AgentScreen.isLoggedOut("● The DB said: Not logged in. Run /login.\n$rule\n❯ Run /login\n$rule\n  ⏵⏵ for agents"),
		)
	}

	@Test
	fun stripsAnsi() {
		// A real capture-pane -e screen wraps cells in SGR escapes; build ESC without a source escape.
		val esc = 27.toChar().toString()
		assertEquals(true, AgentScreen.isReady("${esc}[39m❯ ${esc}[2mTry${esc}[0m"))
		assertEquals(
			true,
			AgentScreen.isWorking("${esc}[38;5;1m✻${esc}[0m Prestidigitating${esc}[2m… (12s ${esc}[2m·${esc}[0m esc to interrupt)"),
		)
		val ruleAnsi = "${esc}[2m" + "─".repeat(40) + "${esc}[0m"
		assertEquals(
			true,
			AgentScreen.isLoggedOut("❯ \n$ruleAnsi\n  for agents  ${esc}[33mNot logged in${esc}[0m · Run /login"),
		)
	}
}
