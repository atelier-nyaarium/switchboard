package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

////////////////////////////////
//  Functions & Helpers

/** Whether [EmptyBoard] has a cause to show, where a Create button would offer what cannot be delivered. */
internal fun emptyBoardHasCause(state: ChatState): Boolean = linkView(state) != LinkView.Online

////////////////////////////////
//  Composables

/** The single status surface when the board has no sessions; one branch per [LinkView]. */
@Composable
internal fun EmptyBoard(
	state: ChatState,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onRefresh: () -> Unit,
	onVerifyEnroll: (() -> Unit)? = null,
	// Reaching a self-hosted Router is a precondition for having any Gateway at all, so the entry
	// point belongs here too and not only behind Settings.
	onRouterEndpoint: (() -> Unit)? = null,
) {
	Column(
		Modifier.fillMaxSize().padding(32.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		when (val view = linkView(state)) {
			is LinkView.NoGateway -> if (view.awaitingHost) {
				Text("You're all set up", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("Your Domain is ready. Set up a computer to run your agents, then add its Gateway here.")
				// A waiting trust compare takes the primary slot.
				if (onVerifyEnroll != null) {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onVerifyEnroll)) { Text("Verify with the admin") }
					Spacer(Modifier.height(4.dp))
					TextButton(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				} else {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				}
			} else {
				Text("No Gateways yet", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("The computer that runs your agents.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onHostHelp)) { Text("Running Gateway Setup") }
				if (onRouterEndpoint != null) {
					TextButton(onClick = hapticClick(onRouterEndpoint)) { Text("Set the Router address") }
				}
			}
			is LinkView.Refused -> {
				Text("Can't connect", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody(view.cause)
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onRefresh)) { Text("Try again") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onManage)) { Text("Gateways") }
			}
			is LinkView.Connecting -> Waiting("Connecting...", view.cause)
			is LinkView.Reconnecting -> Waiting("Reconnecting...", view.cause)
			is LinkView.Offline -> Waiting("Reconnecting...", view.cause)
			LinkView.Online -> Text("No active sessions yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** A spinner over a line, with the cause beneath when one is known. */
@Composable
private fun Waiting(line: String, cause: String?) {
	CircularProgressIndicator()
	Spacer(Modifier.height(12.dp))
	Text(line, color = MaterialTheme.colorScheme.onSurfaceVariant)
	cause?.takeIf { it.isNotBlank() }?.let {
		Spacer(Modifier.height(8.dp))
		BoardBody(it)
	}
}

/** Centered, muted body copy shared by the empty-board states. */
@Composable
private fun BoardBody(text: String) {
	Text(
		text,
		style = MaterialTheme.typography.bodyMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		textAlign = TextAlign.Center,
	)
}
