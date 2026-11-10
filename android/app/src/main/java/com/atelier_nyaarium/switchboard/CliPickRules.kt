package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CliPick
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.readHarness

////////////////////////////////
//  Interfaces & Types

/** One CLI toggle, by its wire word. */
internal data class CliChoice(val wire: String, val label: String, val offered: Boolean = true)

////////////////////////////////
//  Functions & Helpers

/** What the spawn point runs. A shown pick it no longer runs stays, first and marked. */
internal fun cliChoices(available: SpawnHarnesses, shown: String?): List<CliChoice> {
	val offered = harnessesOf(available).map { CliChoice(it.wire, it.label) }
	if (shown == null || offered.any { it.wire == shown }) return offered
	val label = (readHarness(shown) as? HarnessWord.Named)?.harness?.label ?: shown
	return listOf(CliChoice(shown, label, offered = false)) + offered
}

/** A held pick as read. Null for a word this build cannot read, which a put keeps by sending none. */
internal fun pickOf(wire: String?): CliPick? =
	when (val word = wire?.let(::readHarness)) {
		null, HarnessWord.Unpicked -> CliPick.Unpicked
		is HarnessWord.Named -> CliPick.Picked(word.harness)
		is HarnessWord.Unnamed, is HarnessWord.Unknown -> null
	}

/** The toggle that reads as selected; an unread held word shows as itself. */
internal fun shownPick(pick: CliPick?, unread: String?): String? =
	when (pick) {
		is CliPick.Picked -> pick.harness.wire
		CliPick.Unpicked -> null
		null -> unread
	}

/** Tapping the shown pick clears it only if CLIs unknown. */
internal fun pickAfterTap(pick: CliPick?, unread: String?, tapped: String, available: SpawnHarnesses): CliPick? {
	if (tapped == shownPick(pick, unread)) return if (available is SpawnHarnesses.Unknown) CliPick.Unpicked else pick
	val harness = (readHarness(tapped) as? HarnessWord.Named)?.harness ?: return pick
	return CliPick.Picked(harness)
}

/** Gateway refuses no pick among several CLIs. */
internal fun cliRefusal(pick: CliPick?, available: SpawnHarnesses): String? =
	if (pick == CliPick.Unpicked && available is SpawnHarnesses.Known && available.installed.size > 1) PICK_A_CLI else null

internal const val PICK_A_CLI = "Pick a CLI"

/** New session's default: Claude where offered, else the first. */
internal fun freshPick(available: SpawnHarnesses): CliPick =
	harnessAfterPick(SessionHarness.CLAUDE, harnessesOf(available))?.let { CliPick.Picked(it) } ?: CliPick.Unpicked

/** Chosen pick stays. */
internal fun pickOnSpawnChange(pick: CliPick?, chosen: Boolean, available: SpawnHarnesses): CliPick? =
	if (chosen) pick else freshPick(available)
