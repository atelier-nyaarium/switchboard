package com.atelier_nyaarium.switchboard.assistant

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.atelier_nyaarium.switchboard.BuildConfig
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.assistantRoleHeld
import com.atelier_nyaarium.switchboard.runIsolated
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * What the phone would let the assistant do, for a later integrations plan. Debug builds only,
 * best effort, and only allowlisted counts, booleans and setting states: nothing it names is a package, an
 * activity, a key, text or an image. A resolve is a dry run; nothing is started.
 */
internal object IntegrationProbe {
	private val CANDIDATES = listOf(
		Manifest.permission.SEND_SMS,
		Manifest.permission.CALL_PHONE,
		Manifest.permission.READ_CALENDAR,
		Manifest.permission.WRITE_CALENDAR,
		Manifest.permission.READ_CONTACTS,
		Manifest.permission.ACCESS_FINE_LOCATION,
		Manifest.permission.READ_MEDIA_IMAGES,
	)

	private const val IFTTT = "com.ifttt.ifttt"

	// System queries can be slow; never on a caller's thread.
	private val scope = CoroutineScope(
		SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, e -> DebugLog.log("Probe", "failed: ${e.javaClass.simpleName}") },
	)

	fun report(context: Context, kind: String) {
		if (!BuildConfig.DEBUG) return
		val app = context.applicationContext
		scope.launch { runIsolated { DebugLog.log("Probe", probeLine(kind, facts(app))) } }
	}

	private fun facts(context: Context): Map<String, Any> {
		val pm = context.packageManager
		val declared = runIsolated {
			pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions?.toSet()
		}.getOrNull().orEmpty()
		val facts = linkedMapOf<String, Any>(
			"roleHeld" to assistantRoleHeld(context),
			"sessionAdopted" to assistantSessionAdopted(context),
			"assistStructure" to secureSetting(context, "assist_structure_enabled"),
			"assistScreenshot" to secureSetting(context, "assist_screenshot_enabled"),
			"torchCameras" to torchCameras(context),
			"alarm" to resolves(pm, Intent(AlarmClock.ACTION_SET_ALARM)),
			"smsCompose" to resolves(pm, Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:"))),
			"dial" to resolves(pm, Intent(Intent.ACTION_DIAL, Uri.parse("tel:"))),
			"calendarInsert" to resolves(pm, Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)),
			"ifttt" to (runIsolated { pm.getLaunchIntentForPackage(IFTTT) }.getOrNull() != null),
			"notificationListener" to runIsolated {
				context.packageName in NotificationManagerCompat.getEnabledListenerPackages(context)
			}.getOrDefault(false),
			"dndAccess" to runIsolated {
				context.getSystemService(NotificationManager::class.java)?.isNotificationPolicyAccessGranted == true
			}.getOrDefault(false),
			"accessibility" to runIsolated {
				Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
					?.contains(context.packageName) == true
			}.getOrDefault(false),
		)
		for (permission in CANDIDATES) {
			val name = permission.substringAfterLast('.')
			facts["${name}Declared"] = permission in declared
			facts["${name}Granted"] = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
		}
		return facts
	}

	/** "on", "off", "unset", or "unreadable": a hidden setting may refuse an app. */
	private fun secureSetting(context: Context, key: String): String =
		runIsolated { Settings.Secure.getInt(context.contentResolver, key, -1) }.getOrNull()
			?.let { if (it == -1) "unset" else if (it != 0) "on" else "off" } ?: "unreadable"

	private fun torchCameras(context: Context): Int = runIsolated {
		val cameras = context.getSystemService(CameraManager::class.java) ?: return@runIsolated 0
		cameras.cameraIdList.count { cameras.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
	}.getOrDefault(0)

	private fun resolves(pm: PackageManager, intent: Intent): Boolean =
		runIsolated { pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).isNotEmpty() }.getOrDefault(false)
}
