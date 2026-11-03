package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.SetupRun
import com.atelier_nyaarium.switchboard.SetupStage
import com.atelier_nyaarium.switchboard.SignalBars
import com.atelier_nyaarium.switchboard.WifiSight
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.signalBars
import com.atelier_nyaarium.switchboard.nameReady
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.setupPassword
import com.atelier_nyaarium.switchboard.vault.grantableOn
import com.atelier_nyaarium.switchboard.wifiSight
import kotlinx.coroutines.launch

private val WIFI_LIST_HEIGHT = 240.dp

/** Hands a fresh plug the home WiFi, then waits for it there. */
@Composable
internal fun PlugSetupPage(repo: ChatRepository, gatewayId: String, onDevice: (String) -> Unit, onBack: () -> Unit) {
	val held by repo.plugSetupOps.view.collectAsState()
	val run = held?.takeIf { it.gatewayId == gatewayId }
	AssistantPageScaffold(run?.plug?.model ?: "New device", onBack) {
		when (run?.stage) {
			null -> Unit
			SetupStage.JOINING -> Waiting("Select your new device.")
			SetupStage.READY -> ReadyStep(repo, run)
			SetupStage.HANDING -> Waiting("Sending your WiFi to ${run.name}")
			SetupStage.WAITING -> Waiting("Waiting for ${run.name} to join ${run.home?.ssid}")
			SetupStage.ASK_PASSWORD -> AskPasswordStep(repo, run)
			SetupStage.DONE -> {
				Text("${run.name} is set up", style = MaterialTheme.typography.titleMedium)
				run.deviceId?.let { id -> Button(onClick = hapticClick { onDevice(id) }) { Text("Open") } }
			}
			SetupStage.FAILED -> {
				run.said?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
				Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					if (run.home != null) OutlinedButton(onClick = hapticClick { repo.command { plugSetupOps.watchAgain() } }) { Text("Keep waiting") }
					OutlinedButton(onClick = hapticClick { repo.command { plugSetupOps.start(gatewayId, run.networkPrefix) } }) { Text("Start over") }
				}
			}
		}
		if (run != null && run.stage != SetupStage.DONE) {
			HorizontalDivider()
			TextButton(onClick = hapticClick {
				repo.plugSetupOps.cancel()
				onBack()
			}) { Text("Cancel") }
		}
	}
}

@Composable
private fun Waiting(line: String) {
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		CircularProgressIndicator()
		Text(line, style = MaterialTheme.typography.bodyMedium)
	}
}

@Composable
private fun ReadyStep(repo: ChatRepository, run: SetupRun) {
	val plug = run.plug ?: return
	val activity = LocalContext.current as? FragmentActivity
	val scope = rememberCoroutineScope()
	var name by rememberSaveable(plug.mac) { mutableStateOf(run.name.orEmpty()) }
	var entry by remember { mutableStateOf(repo.plugSetupOps.memory().wifiEntry) }
	var choosing by remember { mutableStateOf(false) }
	var asking by remember { mutableStateOf(false) }
	val sight = remember(run.homes) { wifiSight(run.homes, repo.plugSetupOps.memory()) }
	var listing by rememberSaveable(plug.mac) { mutableStateOf(false) }
	val entries = remember { repo.vaultOps.views() }
	val offered = remember(entries) { entries.grantableOn(run.gatewayId) }

	Text("${plug.model} · ${plug.mac}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
	Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.weight(1f)) {
			Text("Your WiFi", style = MaterialTheme.typography.bodyLarge)
			when (sight) {
				WifiSight.Unknown -> Unit
				is WifiSight.Seen -> Text(sight.home.ssid, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				is WifiSight.NotSeen -> Text("Can't see ${sight.ssid}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			}
		}
		if (sight != WifiSight.Unknown && !listing) TextButton(onClick = hapticClick { listing = true }) { Text("Change") }
	}
	if (sight == WifiSight.Unknown || listing) {
		Column(Modifier.fillMaxWidth().heightIn(max = WIFI_LIST_HEIGHT).verticalScroll(rememberScrollState())) {
			for (home in run.homes) {
				Row(
					Modifier.fillMaxWidth().clickable(onClick = hapticClick { repo.plugSetupOps.pickHome(home) }),
					verticalAlignment = Alignment.CenterVertically,
				) {
					RadioButton(selected = run.home == home, onClick = hapticClick { repo.plugSetupOps.pickHome(home) })
					Text(home.ssid, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
					signalBars(home.signal)?.let { SignalBars(it, Modifier.padding(end = 8.dp)) }
				}
			}
		}
	}
	Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.weight(1f)) {
			Text("Password from the vault", style = MaterialTheme.typography.bodyLarge)
			entries.find { it.id == entry }?.title?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		TextButton(onClick = hapticClick { choosing = true }) { Text("Choose") }
	}
	Button(
		onClick = hapticClick {
			scope.launch {
				val password = setupPassword(entry) { id -> if (repo.vaultOps.ownerPresent(activity)) repo.vaultOps.reveal(id) else null }
				if (password == null) asking = true else repo.command { plugSetupOps.hand(name.trim(), password, entry) }
			}
		},
		enabled = run.home != null && nameReady(name),
	) { Text("Set up") }

	if (choosing) {
		GrantSecretsSheet(
			entries = offered,
			granted = listOfNotNull(entry),
			onDone = { picks ->
				choosing = false
				entry = picks.lastOrNull()
			},
			onDismiss = { choosing = false },
		)
	}
	if (asking) {
		PasswordDialog(
			onDone = { typed ->
				asking = false
				repo.command { plugSetupOps.hand(name.trim(), typed, entry) }
			},
			onDismiss = { asking = false },
		)
	}
}

@Composable
private fun AskPasswordStep(repo: ChatRepository, run: SetupRun) {
	var typed by remember { mutableStateOf("") }
	run.said?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
	Text("Password for ${run.home?.ssid}. You'll pick the plug's network again.", style = MaterialTheme.typography.labelLarge)
	OutlinedTextField(
		value = typed,
		onValueChange = { typed = it },
		label = { Text("Password") },
		singleLine = true,
		visualTransformation = PasswordVisualTransformation(),
		modifier = Modifier.fillMaxWidth(),
	)
	Button(
		onClick = hapticClick { repo.command { plugSetupOps.hand(run.name.orEmpty(), typed, null) } },
		enabled = typed.isNotEmpty(),
	) { Text("Try again") }
}

@Composable
private fun PasswordDialog(onDone: (String) -> Unit, onDismiss: () -> Unit) {
	var typed by remember { mutableStateOf("") }
	androidx.compose.material3.AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("WiFi password") },
		text = {
			OutlinedTextField(
				value = typed,
				onValueChange = { typed = it },
				label = { Text("Password") },
				singleLine = true,
				visualTransformation = PasswordVisualTransformation(),
			)
		},
		confirmButton = { TextButton(onClick = hapticClick { onDone(typed) }, enabled = typed.isNotEmpty()) { Text("Use") } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}
