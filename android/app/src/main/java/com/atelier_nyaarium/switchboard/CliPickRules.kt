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

/** A tap picks; a tap on the shown one clears it. */
internal fun pickAfterTap(pick: CliPick?, unread: String?, tapped: String): CliPick {
	val harness = (readHarness(tapped) as? HarnessWord.Named)?.harness
	if (harness == null || tapped == shownPick(pick, unread)) return CliPick.Unpicked
	return CliPick.Picked(harness)
}

/** New session's default: Claude where offered, else the first. */
internal fun freshPick(available: SpawnHarnesses): CliPick =
	harnessAfterPick(SessionHarness.CLAUDE, harnessesOf(available))?.let { CliPick.Picked(it) } ?: CliPick.Unpicked
