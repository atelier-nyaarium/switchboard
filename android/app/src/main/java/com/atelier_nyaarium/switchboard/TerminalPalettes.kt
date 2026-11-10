package com.atelier_nyaarium.switchboard

import androidx.compose.ui.graphics.Color
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import com.atelier_nyaarium.switchboard.proto.ShellMacro
import com.atelier_nyaarium.switchboard.proto.SlashMacro

////////////////////////////////
//  Key and macro palettes

// The fixed control-key palette: a label shown on the chip and the tmux key name sent.
internal val PALETTE_KEYS = listOf(
	"Esc" to "Escape",
	"Tab" to "Tab",
	"Up" to "Up",
	"Down" to "Down",
	"Left" to "Left",
	"Right" to "Right",
	"Pg Up" to "PageUp",
	"Pg Down" to "PageDown",
)

// The modifier-combo menu the "Ctrl" chip opens, in place of a single fixed key: a label shown in
// the dropdown and the tmux key name sent.
internal val CTRL_MENU_KEYS = listOf(
	"Shift + Tab" to "BTab",
	"Ctrl + O" to "C-o",
	"Ctrl + T" to "C-t",
	"Ctrl + S" to "C-s",
	"Ctrl + C" to "C-c",
)

/** The CLI's commands. */
internal fun slashMacros(word: HarnessWord): List<SlashMacro> =
	when (word) {
		is HarnessWord.Named -> word.harness.slashPalette
		is HarnessWord.Unnamed -> word.assumed.slashPalette
		is HarnessWord.Unknown -> emptyList()
	}

/** Each installed CLI's macros; every CLI's where none is, so one can be. */
internal fun shellMacros(held: SpawnHarnesses): List<ShellMacro> =
	harnessesOf(held).ifEmpty { SessionHarness.entries }.flatMap { it.shellMacros }

// Macro chip label color: orange fires Enter immediately, blue only stages text.
internal val MACRO_AUTO_SEND_COLOR = Color(0xFFFF9800)
internal val MACRO_STAGE_ONLY_COLOR = Color(0xFF2196F3)
