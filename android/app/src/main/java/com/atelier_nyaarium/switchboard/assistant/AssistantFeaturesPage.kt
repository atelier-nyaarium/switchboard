package com.atelier_nyaarium.switchboard.assistant

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.PhoneCapabilities
import com.atelier_nyaarium.switchboard.assistantRoleHeld
import com.atelier_nyaarium.switchboard.assistantScreenDataEnabled
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.openAssistantPicker
import com.atelier_nyaarium.switchboard.runIsolated

@Composable
internal fun AssistantFeaturesPage(repo: ChatRepository, onBack: () -> Unit) {
	val context = androidx.compose.ui.platform.LocalContext.current
	val toggles = repo.phoneCapabilityOps.features
	val wanted by toggles.wanted.collectAsState()
	var tick by remember { mutableStateOf(0) }
	// Grants change while away.
	androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
		tick++
		onPauseOrDispose {}
	}
	var asking by remember { mutableStateOf<String?>(null) }
	var denied by remember { mutableStateOf(setOf<String>()) }
	var saveFailed by remember { mutableStateOf(false) }
	val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		if (!granted) asking?.let { denied = denied + it }
		asking = null
		tick++
	}
	val views = remember(tick, wanted) {
		featureViews(featureRows(PhoneCapabilities.bindings.values), wanted, repo.phoneCapabilityOps::grants)
	}
	val phoneSettings = remember(tick) { phoneSettingFacts(context) }
	val open = { need: String ->
		val manifest = manifestPermissionOf(need)
		val rationale = manifest != null && (context as? android.app.Activity)?.shouldShowRequestPermissionRationale(manifest) == true
		when (permissionDoor(need, askable(need, denied, rationale))) {
			PermissionDoor.REQUEST -> manifest?.let {
				asking = need
				request.launch(it)
			}
			PermissionDoor.APP_SETTINGS -> openAppSettings(context)
			PermissionDoor.LISTENER_SETTINGS -> openNotificationListenerSettings(context)
		}
	}
	AssistantPageScaffold("Features", onBack) {
		if (saveFailed) Text("Could not save", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		Text("Phone settings", style = MaterialTheme.typography.labelLarge)
		for (row in phoneSettingRows(phoneSettings)) {
			PhoneSettingRowView(row) {
				when (row.door) {
					PhoneSettingDoor.PICKER -> openAssistantPicker(context)
					PhoneSettingDoor.NOTIFICATIONS -> open("notifications")
					PhoneSettingDoor.NOTIFICATION_PAGE -> openNotificationSettings(context)
				}
			}
		}
		HorizontalDivider()
		Text("The assistant may", style = MaterialTheme.typography.labelLarge)
		for (view in views) {
			FeatureRowView(
				view,
				featureRowModel(view),
				onToggle = { on -> saveFailed = !toggles.setWanted(view.row.key, toggledWanted(view, on)) },
				onGear = { gear ->
					when (gear) {
						is GearTarget.Need -> open(gear.need)
						GearTarget.AppSettings -> openAppSettings(context)
					}
				},
			)
		}
	}
}

@Composable
private fun PhoneSettingRowView(row: PhoneSettingRow, onGear: () -> Unit) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Column(Modifier.weight(1f)) {
			Text(row.label, style = MaterialTheme.typography.bodyLarge)
			Text(
				if (row.on) "On" else row.offWord,
				style = MaterialTheme.typography.bodySmall,
				color = if (row.on) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
			)
		}
		IconButton(onClick = hapticClick(onGear)) { Icon(Icons.Default.Settings, contentDescription = "Open setting") }
	}
}

@Composable
private fun FeatureRowView(view: FeatureView, model: FeatureRowModel, onToggle: (Boolean) -> Unit, onGear: (GearTarget) -> Unit) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Text(view.row.label, style = MaterialTheme.typography.bodyLarge)
			needsLine(view)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		}
		Switch(checked = view.wanted, onCheckedChange = onToggle, enabled = model.switchEnabled)
		val gear = model.gear
		if (gear == null) {
			Spacer(Modifier.size(48.dp))
		} else {
			IconButton(onClick = hapticClick { onGear(gear) }) { Icon(Icons.Default.Settings, contentDescription = "Open permission") }
		}
	}
}

internal fun phoneSettingFacts(context: android.content.Context) = PhoneSettingFacts(
	roleHeld = assistantRoleHeld(context),
	sessionAdopted = assistantSessionAdopted(context),
	screenData = assistantScreenDataEnabled(context),
	notifications = grantedOn(context, "notifications"),
)

private fun grantedOn(context: android.content.Context, need: String): Boolean {
	val manifest = manifestPermissionOf(need) ?: return false
	return runIsolated { context.checkSelfPermission(manifest) == android.content.pm.PackageManager.PERMISSION_GRANTED }
		.getOrDefault(false)
}

private fun openNotificationSettings(context: android.content.Context) {
	runIsolated {
		context.startActivity(
			android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
				.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
				.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
		)
	}
}

private fun openNotificationListenerSettings(context: android.content.Context) {
	runIsolated {
		context.startActivity(
			android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
				.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
		)
	}
}

private fun openAppSettings(context: android.content.Context) {
	runIsolated {
		context.startActivity(
			android.content.Intent(
				android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
				android.net.Uri.fromParts("package", context.packageName, null),
			).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
		)
	}
}
