package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.PasswordSource
import com.atelier_nyaarium.switchboard.SetupRun
import com.atelier_nyaarium.switchboard.SetupStage
import com.atelier_nyaarium.switchboard.SignalBars
import com.atelier_nyaarium.switchboard.WifiLine
import com.atelier_nyaarium.switchboard.defaultSource
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.homeRows
import com.atelier_nyaarium.switchboard.routines.GrantSecretsSheet
import com.atelier_nyaarium.switchboard.scrollThumb
import com.atelier_nyaarium.switchboard.setupPassword
import com.atelier_nyaarium.switchboard.setupReady
import com.atelier_nyaarium.switchboard.vault.grantableOn
import com.atelier_nyaarium.switchboard.wifiLine
import com.atelier_nyaarium.switchboard.wifiListOpen
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
			SetupStage.JOINING -> Text("Select your new device.", style = MaterialTheme.typography.bodyMedium)
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
	val memory = remember { repo.plugSetupOps.memory() }
	var entry by remember { mutableStateOf(memory.wifiEntry) }
	var source by rememberSaveable(plug.mac) { mutableStateOf(defaultSource(memory)) }
	var typed by remember { mutableStateOf("") }
	var choosing by remember { mutableStateOf(false) }
	var changing by rememberSaveable(plug.mac) { mutableStateOf(false) }
	val entries = remember { repo.vaultOps.views() }
	val offered = remember(entries) { entries.grantableOn(run.gatewayId) }

	Text("${plug.model} · ${plug.mac}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
	OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
	val open = wifiListOpen(run, changing)
	Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
		Column(Modifier.weight(1f)) {
			Text("Your WiFi", style = MaterialTheme.typography.bodyLarge)
			WifiLineView(wifiLine(run, open))
		}
		if (!open) TextButton(onClick = hapticClick { changing = true }) { Text("Change") }
	}
	if (open) {
		val scroll = rememberScrollState()
		Column(
			Modifier.fillMaxWidth().heightIn(max = WIFI_LIST_HEIGHT)
				.scrollThumb(scroll, MaterialTheme.colorScheme.outline)
				.verticalScroll(scroll),
		) {
			for (row in homeRows(run)) {
				Row(
					Modifier.fillMaxWidth()
						.selectable(row.picked, role = Role.RadioButton, onClick = hapticClick {
							repo.plugSetupOps.pickHome(row.home)
							changing = false
						})
						.padding(horizontal = 12.dp, vertical = 12.dp),
					verticalAlignment = Alignment.CenterVertically,
					horizontalArrangement = Arrangement.spacedBy(16.dp),
				) {
					val bars = row.bars
					if (bars == null) RadioButton(selected = row.picked, onClick = null) else SignalBars(bars)
					Text(row.home.ssid, style = MaterialTheme.typography.bodyLarge)
				}
			}
		}
	}
	SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
		PasswordSource.entries.forEachIndexed { at, option ->
			SegmentedButton(
				selected = source == option,
				onClick = hapticClick { source = option },
				shape = SegmentedButtonDefaults.itemShape(index = at, count = PasswordSource.entries.size),
			) { Text(if (option == PasswordSource.TYPED) "Type password" else "Vault") }
		}
	}
	when (source) {
		PasswordSource.TYPED -> PasswordField(typed, onChange = { typed = it })
		PasswordSource.VAULT -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
			val title = entries.find { it.id == entry }?.title
			Text(title.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
			TextButton(onClick = hapticClick { choosing = true }) { Text(if (title == null) "Choose" else "Change") }
		}
	}
	Button(
		onClick = hapticClick {
			scope.launch {
				when (source) {
					PasswordSource.TYPED -> repo.command { plugSetupOps.hand(name.trim(), typed, null) }
					PasswordSource.VAULT -> {
						val password = setupPassword(entry) { id -> if (repo.vaultOps.ownerPresent(activity)) repo.vaultOps.reveal(id) else null }
						if (password == null) source = PasswordSource.TYPED else repo.command { plugSetupOps.hand(name.trim(), password, entry) }
					}
				}
			}
		},
		enabled = setupReady(run, name, source, typed, entry),
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
}

@Composable
private fun WifiLineView(line: WifiLine) {
	when (line) {
		WifiLine.Blank -> Unit
		is WifiLine.Picked -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			line.bars?.let { SignalBars(it) }
			Text(line.ssid, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		is WifiLine.Unseen -> Text("Can't see ${line.ssid}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
	}
}

@Composable
private fun PasswordField(value: String, onChange: (String) -> Unit) {
	var shown by remember { mutableStateOf(false) }
	OutlinedTextField(
		value = value,
		onValueChange = onChange,
		label = { Text("Password") },
		singleLine = true,
		visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
		trailingIcon = {
			IconButton(onClick = hapticClick { shown = !shown }) {
				Icon(
					if (shown) Icons.Default.VisibilityOff else Icons.Default.Visibility,
					contentDescription = if (shown) "Hide password" else "Show password",
				)
			}
		},
		modifier = Modifier.fillMaxWidth(),
	)
}

@Composable
private fun AskPasswordStep(repo: ChatRepository, run: SetupRun) {
	var typed by remember { mutableStateOf("") }
	run.said?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
	Text("Password for ${run.home?.ssid}. You'll pick the plug's network again.", style = MaterialTheme.typography.labelLarge)
	PasswordField(typed, onChange = { typed = it })
	Button(
		onClick = hapticClick { repo.command { plugSetupOps.hand(run.name.orEmpty(), typed, null) } },
		enabled = typed.isNotEmpty(),
	) { Text("Try again") }
}
