package com.atelier_nyaarium.switchboard.assistant

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.DeviceListView
import com.atelier_nyaarium.switchboard.DevicesView
import com.atelier_nyaarium.switchboard.FoundDevice
import com.atelier_nyaarium.switchboard.PairChoice
import com.atelier_nyaarium.switchboard.PhoneScanView
import com.atelier_nyaarium.switchboard.RadioReadiness
import com.atelier_nyaarium.switchboard.ScanView
import com.atelier_nyaarium.switchboard.THIS_PHONE
import com.atelier_nyaarium.switchboard.busy
import com.atelier_nyaarium.switchboard.definitionHit
import com.atelier_nyaarium.switchboard.displayUnitOf
import com.atelier_nyaarium.switchboard.foundDevices
import com.atelier_nyaarium.switchboard.foundModel
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.landedOn
import com.atelier_nyaarium.switchboard.mainValue
import com.atelier_nyaarium.switchboard.onPhones
import com.atelier_nyaarium.switchboard.pairChoices
import com.atelier_nyaarium.switchboard.pairedAcross
import com.atelier_nyaarium.switchboard.pairingOf
import com.atelier_nyaarium.switchboard.proto.Integration
import com.atelier_nyaarium.switchboard.readinessLine
import com.atelier_nyaarium.switchboard.saidOf
import com.atelier_nyaarium.switchboard.sensorOf
import com.atelier_nyaarium.switchboard.sensorTrouble
import com.atelier_nyaarium.switchboard.sightingOf
import com.atelier_nyaarium.switchboard.signalBars
import com.atelier_nyaarium.switchboard.testedLine
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun ListenEntryPage(
	repo: ChatRepository,
	state: ChatState,
	home: String,
	integration: Integration,
	onDevice: (String, String) -> Unit,
	onBack: () -> Unit,
) {
	val views by repo.deviceOps.views.collectAsState()
	val phone by repo.phoneRadio.scanView.collectAsState()
	val roster = state.gateways.ids()
	var pairing by remember { mutableStateOf<FoundDevice?>(null) }
	var pairingOn by remember { mutableStateOf<String?>(null) }
	val display = displayUnitOf(state.gateways.assistantOn(home))
	val now = System.currentTimeMillis()
	val scanAll = {
		repo.command {
			coroutineScope {
				for (gatewayId in roster) launch { deviceOps.scan(gatewayId) }
				launch {
					phoneRadio.scan()
				}
			}
		}
	}
	val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { scanAll() }
	val scanning = phone == PhoneScanView.Scanning || roster.any { views[it]?.scan == ScanView.Scanning }
	val paired = roster.flatMap { gatewayId ->
		((views[gatewayId]?.list as? DeviceListView.Listed)?.records.orEmpty()).map { gatewayId to it }
	}
	val found = foundDevices(
		family = integration.id,
		gateways = roster.associateWith { gatewayId ->
			(views[gatewayId]?.scan as? ScanView.Found)?.nearby.orEmpty().map(::sightingOf)
		},
		phone = (phone as? PhoneScanView.Heard)?.sightings.orEmpty(),
		paired = pairedAcross(roster.mapNotNull { views[it] }),
		definitionOf = { advert -> definitionHit(integration.id, advert) },
	)

	AssistantPageScaffold(
		integration.label,
		onBack,
		actions = {
			OutlinedButton(
				onClick = hapticClick {
					if (repo.phoneRadio.readiness() == RadioReadiness.NOT_GRANTED) ask.launch(Manifest.permission.BLUETOOTH_SCAN) else scanAll()
				},
				enabled = !scanning,
			) {
				if (scanning) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Scan")
			}
		},
	) {
		for (gatewayId in roster) {
			(views[gatewayId]?.scan as? ScanView.Failed)?.let {
				Text("$gatewayId: ${it.line}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
			}
		}
		(phone as? PhoneScanView.Unavailable)?.let { readinessLine(it.readiness) }?.let {
			Text("$THIS_PHONE: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		(phone as? PhoneScanView.Failed)?.let {
			Text("$THIS_PHONE: ${it.line}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
		if (found.isNotEmpty()) {
			Text("Found", style = MaterialTheme.typography.labelLarge)
			for (device in found) FoundRow(device) { pairing = device }
		}
		val ours = paired.filter { (_, record) -> record.driver == integration.id }
		if (ours.isNotEmpty()) {
			if (found.isNotEmpty()) HorizontalDivider()
			Text("Paired", style = MaterialTheme.typography.labelLarge)
			for ((gatewayId, record) in ours) {
				val devices = views[gatewayId] ?: DevicesView()
				val held = devices.sensorOf(record.id)
				Row(
					Modifier.fillMaxWidth().clickable(onClick = hapticClick { onDevice(gatewayId, record.id) }).padding(vertical = 6.dp),
					verticalAlignment = Alignment.CenterVertically,
					horizontalArrangement = Arrangement.spacedBy(8.dp),
				) {
					Column(Modifier.weight(1f)) {
						Text(record.name, style = MaterialTheme.typography.bodyLarge)
						Text(
							listOfNotNull(held?.read?.model, if (record.onPhones()) THIS_PHONE else gatewayId).joinToString(" · "),
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
						sensorTrouble(held, now)?.let {
							Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
						}
						devices.saidOf(record.id)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
					}
					mainValue(held, display)?.let {
						Text(
							it.text,
							style = MaterialTheme.typography.bodyLarge,
							color = if (it.stale) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
						)
					}
				}
			}
		}
	}

	pairing?.let { device ->
		val chosen = pairingOn
		if (chosen != null && landedOn(paired, device.mac, chosen)) {
			LaunchedEffect(device.mac, chosen) {
				pairing = null
				pairingOn = null
				onDevice(chosen, device.mac)
			}
			return@let
		}
		val choices = pairChoices(device, home)
		val busy = choices.any { choice -> views[choice.gatewayId ?: home]?.busy(device.mac) == true }
		val said = choices.firstNotNullOfOrNull { choice -> views[choice.gatewayId ?: home]?.saidOf(device.mac) }
		PairWithDialog(device, choices, busy, said, onDismiss = { pairing = null }) { choice ->
			val (gatewayId, pair) = pairingOf(device, choice, home)
			pairingOn = gatewayId
			repo.command { deviceOps.addSensor(gatewayId, pair, device.advert.name ?: device.mac) }
		}
	}
}

@Composable
private fun FoundRow(device: FoundDevice, onAdd: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		SignalBars(signalBars(device.strongest))
		Column(Modifier.weight(1f)) {
			Text(device.advert.name ?: device.mac, style = MaterialTheme.typography.bodyLarge)
			(foundModel(device) ?: testedLine(device))?.let {
				Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		OutlinedButton(onClick = hapticClick(onAdd)) { Text("Add") }
	}
}

@Composable
private fun SignalBars(bars: Int) {
	Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom) {
		for (at in 1..4) {
			Box(
				Modifier.width(3.dp).height((4 * at).dp).background(
					if (at <= bars) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
					RoundedCornerShape(1.dp),
				),
			)
		}
	}
}

@Composable
private fun PairWithDialog(
	device: FoundDevice,
	choices: List<PairChoice>,
	busy: Boolean,
	said: String?,
	onDismiss: () -> Unit,
	onPick: (PairChoice) -> Unit,
) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Pair with") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
				Text(
					listOfNotNull(device.advert.name, foundModel(device), testedLine(device)).joinToString(" · "),
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				for (choice in choices) {
					Row(
						Modifier.fillMaxWidth().clickable(enabled = !busy, onClick = hapticClick { onPick(choice) }).padding(vertical = 10.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Text(choice.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
						Text(
							if (choice.assistant) "Assistant" else "App only",
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSecondaryContainer,
							modifier = Modifier
								.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(50))
								.padding(horizontal = 8.dp, vertical = 2.dp),
						)
					}
				}
				if (busy) CircularProgressIndicator(Modifier.size(18.dp))
				said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
			}
		},
		confirmButton = {},
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}
