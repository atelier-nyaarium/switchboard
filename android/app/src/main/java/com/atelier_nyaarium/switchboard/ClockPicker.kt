package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.atelier_nyaarium.switchboard.routines.clockOf
import com.atelier_nyaarium.switchboard.routines.clockText

@OptIn(ExperimentalMaterial3Api::class)
/** Picks an HH:MM time. */
@Composable
internal fun ClockPickerDialog(time: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
	val (hour, minute) = clockOf(time)
	val clock = rememberTimePickerState(
		initialHour = hour,
		initialMinute = minute,
		is24Hour = android.text.format.DateFormat.is24HourFormat(LocalContext.current),
	)
	Dialog(onDismissRequest = onDismiss, properties = NO_TAP_AWAY) {
		Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
			Column(
				Modifier.padding(24.dp),
				horizontalAlignment = Alignment.CenterHorizontally,
				verticalArrangement = Arrangement.spacedBy(20.dp),
			) {
				Text("Time", style = MaterialTheme.typography.titleMedium)
				TimePicker(state = clock)
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
					TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") }
					TextButton(onClick = hapticClick { onPick(clockText(clock.hour, clock.minute)) }) { Text("OK") }
				}
			}
		}
	}
}
