package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType

/** Typed as written. Single-line: a password type shows no suggestions. */
internal val EXACT_KEYBOARD =
	KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password)

/** Multi-line: a password type holds one line. */
internal val EXACT_TEXT_KEYBOARD = EXACT_KEYBOARD.copy(keyboardType = KeyboardType.Text)
