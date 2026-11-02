package com.atelier_nyaarium.switchboard

import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import com.atelier_nyaarium.switchboard.proto.AlarmSetAnswer
import com.atelier_nyaarium.switchboard.proto.AlarmSetRequest
import com.atelier_nyaarium.switchboard.proto.AppOpenAnswer
import com.atelier_nyaarium.switchboard.proto.AppOpenRequest
import com.atelier_nyaarium.switchboard.proto.CalendarEventsAnswer
import com.atelier_nyaarium.switchboard.proto.CalendarEventsRequest
import com.atelier_nyaarium.switchboard.proto.ContactsSearchAnswer
import com.atelier_nyaarium.switchboard.proto.ContactsSearchRequest
import com.atelier_nyaarium.switchboard.proto.LaunchableApp
import com.atelier_nyaarium.switchboard.proto.MapsOpenAnswer
import com.atelier_nyaarium.switchboard.proto.MapsOpenRequest
import com.atelier_nyaarium.switchboard.proto.NotificationReplyAnswer
import com.atelier_nyaarium.switchboard.proto.NotificationReplyRequest
import com.atelier_nyaarium.switchboard.proto.NotificationsRecentAnswer
import com.atelier_nyaarium.switchboard.proto.NotificationsRecentRequest
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityHandlers
import com.atelier_nyaarium.switchboard.proto.PhoneContact
import com.atelier_nyaarium.switchboard.proto.PhoneStatusAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneStatusKey
import com.atelier_nyaarium.switchboard.proto.PhoneStatusRequest
import com.atelier_nyaarium.switchboard.proto.TorchAnswer
import com.atelier_nyaarium.switchboard.proto.TorchRequest
import com.atelier_nyaarium.switchboard.proto.TimerSetAnswer
import com.atelier_nyaarium.switchboard.proto.TimerSetRequest
import com.atelier_nyaarium.switchboard.proto.phoneCapabilityBindings
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import kotlin.math.roundToInt

data class CapabilityAvailability(
	val available: Boolean,
	val reason: String? = null,
	val needs: List<String>,
	val missing: List<String> = emptyList(),
)

internal fun permissionState(
	needs: List<String>,
	hasPermission: (String) -> Boolean,
): CapabilityAvailability {
	val missing = needs.filterNot(hasPermission)
	return if (missing.isEmpty()) {
		CapabilityAvailability(true, needs = needs)
	} else {
		CapabilityAvailability(false, "not_granted", needs, missing)
	}
}

/** The torch's camera, if any. */
internal fun backFlashCameraId(manager: CameraManager): String? = manager.cameraIdList.firstOrNull { cameraId ->
	val camera = manager.getCameraCharacteristics(cameraId)
	camera.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK &&
		camera.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
}

class PhoneCapabilityContext(
	val applicationContext: Context,
	val state: () -> ChatState,
	val permissionState: (String) -> CapabilityAvailability,
	val canLaunch: () -> Boolean,
)

internal class CapabilityUnavailable(val reason: String) : Exception()

class PhoneCapability<Req : Any, Ans : Any>(
	val key: String,
	val kind: String,
	val where: String,
	val needs: List<String>,
	val label: String,
	val requestSerializer: KSerializer<Req>,
	val answerSerializer: KSerializer<Ans>,
	val handler: suspend (PhoneCapabilityContext, Req) -> Ans,
)

class PhoneCapabilityBinding internal constructor(
	val key: String,
	val kind: String,
	val where: String,
	val needs: List<String>,
	val requestId: String,
	val answerId: String,
	val label: String,
	val run: suspend (PhoneCapabilityContext, JsonElement) -> PhoneCapabilityAnswer,
)

internal object PhoneCapabilityHandlerSet : PhoneCapabilityHandlers {
	override suspend fun status(context: PhoneCapabilityContext, request: PhoneStatusRequest): PhoneStatusAnswer =
		phoneStatus(context, request)

	override suspend fun contactsSearch(
		context: PhoneCapabilityContext,
		request: ContactsSearchRequest,
	): ContactsSearchAnswer = contactsSearchBody(context, request)

	override suspend fun calendarEvents(
		context: PhoneCapabilityContext,
		request: CalendarEventsRequest,
	): CalendarEventsAnswer = calendarEventsBody(context, request)

	override suspend fun notificationsRecent(
		context: PhoneCapabilityContext,
		request: NotificationsRecentRequest,
	): NotificationsRecentAnswer = notificationsRecentBody(request)

	override suspend fun notificationReply(
		context: PhoneCapabilityContext,
		request: NotificationReplyRequest,
	): NotificationReplyAnswer = notificationReplyBody(context, request)

	override suspend fun torch(context: PhoneCapabilityContext, request: TorchRequest): TorchAnswer =
		torchBody(context, request)

	override suspend fun mapsOpen(context: PhoneCapabilityContext, request: MapsOpenRequest): MapsOpenAnswer =
		mapsOpenBody(context, request)

	override suspend fun appOpen(context: PhoneCapabilityContext, request: AppOpenRequest): AppOpenAnswer =
		appOpenBody(context, request)

	override suspend fun alarmSet(context: PhoneCapabilityContext, request: AlarmSetRequest): AlarmSetAnswer =
		alarmSetBody(context, request)

	override suspend fun timerSet(context: PhoneCapabilityContext, request: TimerSetRequest): TimerSetAnswer =
		timerSetBody(context, request)
}

object PhoneCapabilities {
	val bindings: Map<String, PhoneCapabilityBinding> = phoneCapabilityBindings(PhoneCapabilityHandlerSet)
}

internal fun <Req : Any, Ans : Any> bind(capability: PhoneCapability<Req, Ans>): PhoneCapabilityBinding =
	PhoneCapabilityBinding(
		key = capability.key,
		kind = capability.kind,
		where = capability.where,
		needs = capability.needs,
		requestId = schemaId(capability.requestSerializer),
		answerId = schemaId(capability.answerSerializer),
		label = capability.label,
		run = { context, params ->
			val answer = runCatchingCancellable {
				val request = wireJson.decodeFromJsonElement(capability.requestSerializer, params)
				val result = capability.handler(context, request)
				wireJson.encodeToJsonElement(capability.answerSerializer, result)
			}
			answer.fold(
				onSuccess = { PhoneCapabilityAnswer.Ok(it) },
				onFailure = { error ->
					if (error is CancellationException) throw error
					if (error is CapabilityUnavailable) PhoneCapabilityAnswer.Unavailable(error.reason)
					else PhoneCapabilityAnswer.Unavailable("not_supported")
				},
			)
		},
	)

private fun schemaId(serializer: KSerializer<*>): String = serializer.descriptor.serialName.substringAfterLast('.')

private suspend fun phoneStatus(context: PhoneCapabilityContext, request: PhoneStatusRequest): PhoneStatusAnswer {
	val now = System.currentTimeMillis()
	val hold = context.state().phoneHold
	val holder = hold?.label?.takeIf { holdStanding(hold, now) == HoldStanding.HELD }
	val keys = PhoneCapabilities.bindings.values.map { binding ->
		val state = context.permissionState(binding.key)
		PhoneStatusKey(binding.key, state.available, state.reason, state.needs)
	}
	return PhoneStatusAnswer(holder = holder, keys = keys)
}

private suspend fun contactsSearchBody(
	context: PhoneCapabilityContext,
	request: ContactsSearchRequest,
): ContactsSearchAnswer {
	val limit = (request.limit ?: 5L).coerceIn(1L, 20L).toInt()
	val resolver = context.applicationContext.contentResolver
	val query = request.query.trim()
	if (query.isEmpty() || query.length > 80) return ContactsSearchAnswer(emptyList())
	val matched = linkedMapOf<String, String>()
	val uri = Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI, query)
	resolver.query(
		uri,
		arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME),
		null,
		null,
		null,
	)?.use { cursor ->
		while (cursor.moveToNext() && matched.size < limit) {
			val id = cursor.getString(0) ?: continue
			val name = cursor.getString(1).orEmpty()
			matched.putIfAbsent(id, name)
		}
	}
	val contacts = matched.map { (id, name) ->
		PhoneContact(
			id = id,
			name = name.take(200),
			phones = dataValues(
				resolver.query(
					ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
					arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
					"${ContactsContract.CommonDataKinds.Phone.CONTACT_ID}=?",
					arrayOf(id),
					null,
				),
			).map { it.take(64) },
			emails = dataValues(
				resolver.query(
					ContactsContract.CommonDataKinds.Email.CONTENT_URI,
					arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
					"${ContactsContract.CommonDataKinds.Email.CONTACT_ID}=?",
					arrayOf(id),
					null,
				),
			).map { it.take(254) },
			birthday = birthdayFor(resolver, id),
		)
	}
	return ContactsSearchAnswer(contacts)
}

private suspend fun calendarEventsBody(
	context: PhoneCapabilityContext,
	request: CalendarEventsRequest,
): CalendarEventsAnswer {
	val now = Instant.now()
	val zone = ZoneId.systemDefault()
	val from = request.from?.let { OffsetDateTime.parse(it).toInstant() }
	val days = request.days?.toInt()
	val window = calendarWindow(from, days, now)
	val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
	ContentUris.appendId(builder, window.first.toEpochMilli())
	ContentUris.appendId(builder, window.second.toEpochMilli())
	val uri = builder.build()
	val projection = arrayOf(
		CalendarContract.Instances.EVENT_ID,
		CalendarContract.Instances.TITLE,
		CalendarContract.Instances.BEGIN,
		CalendarContract.Instances.END,
		CalendarContract.Instances.ALL_DAY,
		CalendarContract.Instances.EVENT_LOCATION,
		CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
	)
	val limit = request.limit?.toInt()
	// The cap ends the read.
	val selected = context.applicationContext.contentResolver.query(
		uri,
		projection,
		"${CalendarContract.Instances.VISIBLE}=1",
		null,
		"${CalendarContract.Instances.BEGIN} ASC",
	)?.use { cursor ->
		val rows = generateSequence { if (cursor.moveToNext()) calendarRowOf(cursor) else null }
		selectEvents(rows, request.query, limit)
	}.orEmpty()
	return CalendarEventsAnswer(selected.map { eventOf(it, now, zone) })
}

private fun notificationsRecentBody(
	request: NotificationsRecentRequest,
): NotificationsRecentAnswer {
	val selected = selectNotifications(NotificationRing.shared.all(), request.app, request.limit)
	val zone = ZoneId.systemDefault()
	return NotificationsRecentAnswer(selected.map { notificationOf(it, zone) })
}

private fun notificationReplyBody(
	context: PhoneCapabilityContext,
	request: NotificationReplyRequest,
): NotificationReplyAnswer {
	if (!validReplyRequest(request.id, request.text)) return NotificationReplyAnswer(false)
	// Send outside the lock.
	val reply = NotificationRing.shared.withEntry(request.id) { entry ->
		entry?.replyAction?.let { action -> replyInputOf(entry)?.let { action to it } }
	} ?: return NotificationReplyAnswer(false)
	val (action, remoteInput) = reply
	val intent = Intent()
	RemoteInput.addResultsToIntent(
		arrayOf(remoteInput),
		intent,
		Bundle().apply { putCharSequence(remoteInput.resultKey, request.text) },
	)
	return try {
		action.actionIntent.send(context.applicationContext, 0, intent)
		NotificationReplyAnswer(true)
	} catch (_: PendingIntent.CanceledException) {
		NotificationReplyAnswer(false)
	}
}

private fun calendarRowOf(cursor: Cursor): CalendarRow = CalendarRow(
	id = cursor.getLong(0).toString(),
	title = cursor.getString(1).orEmpty(),
	start = Instant.ofEpochMilli(cursor.getLong(2)),
	end = Instant.ofEpochMilli(cursor.getLong(3)),
	allDay = cursor.getInt(4) != 0,
	location = cursor.getString(5),
	calendar = cursor.getString(6),
)

private fun dataValues(cursor: Cursor?, limit: Int = 16): List<String> = cursor?.use { rows ->
	buildList {
		while (size < limit && rows.moveToNext()) add(rows.getString(0).orEmpty())
	}
}.orEmpty()

private fun birthdayFor(resolver: android.content.ContentResolver, contactId: String): String? = resolver.query(
	ContactsContract.Data.CONTENT_URI,
	arrayOf(ContactsContract.CommonDataKinds.Event.START_DATE),
	"${ContactsContract.Data.CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=? AND ${ContactsContract.CommonDataKinds.Event.TYPE}=?",
	arrayOf(
		contactId,
		ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE,
		ContactsContract.CommonDataKinds.Event.TYPE_BIRTHDAY.toString(),
	),
	null,
)?.use { rows ->
		if (!rows.moveToFirst()) return@use null
		rows.getString(0)?.takeIf(::isBirthday)
	}

private fun isBirthday(value: String): Boolean =
	(value.length == 10 && value[4] == '-' && value[7] == '-' && value.take(4).all { it in '0'..'9' } &&
		value.substring(5, 7).all { it in '0'..'9' } && value.takeLast(2).all { it in '0'..'9' }) ||
	(value.length == 8 && value.startsWith("--") && value[4] == '-' && value.substring(2, 4).all { it in '0'..'9' } &&
		value.takeLast(2).all { it in '0'..'9' })

private suspend fun torchBody(context: PhoneCapabilityContext, request: TorchRequest): TorchAnswer {
	val manager = context.applicationContext.getSystemService(CameraManager::class.java)
		?: throw UnsupportedOperationException()
	val id = backFlashCameraId(manager) ?: throw UnsupportedOperationException()
	val characteristics = manager.getCameraCharacteristics(id)
	val maximum = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
		characteristics.get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1
	} else {
		1
	}
	if (!request.on) {
		manager.setTorchMode(id, false)
	} else if (request.strength != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && maximum > 1) {
		val level = (request.strength.coerceIn(1L, 100L) * maximum / 100.0).roundToInt().coerceIn(1, maximum)
		manager.turnOnTorchWithStrengthLevel(id, level)
	} else {
		manager.setTorchMode(id, true)
	}
	return TorchAnswer(on = request.on, levels = maximum.toLong())
}

private fun mapsOpenBody(context: PhoneCapabilityContext, request: MapsOpenRequest): MapsOpenAnswer {
	val uri = Uri.parse(mapsUri(request.query, request.navigate == true))
	return MapsOpenAnswer(opened = launchIntent(context, Intent(Intent.ACTION_VIEW, uri)))
}

private fun appOpenBody(context: PhoneCapabilityContext, request: AppOpenRequest): AppOpenAnswer {
	val packageManager = context.applicationContext.packageManager
	val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
	val candidates = packageManager.queryIntentActivities(launcher, 0).mapNotNull { resolved ->
		val activity = resolved.activityInfo ?: return@mapNotNull null
		AppCandidate(packageManager.getApplicationLabel(activity.applicationInfo).toString(), activity.packageName)
	}
	return when (val resolution = resolveApp(candidates, request.app)) {
		is AppResolution.One -> {
			val intent = packageManager.getLaunchIntentForPackage(resolution.packageName)
				?: return AppOpenAnswer(opened = false, `package` = resolution.packageName.take(120))
			AppOpenAnswer(
				opened = launchIntent(context, intent),
				`package` = resolution.packageName.take(120),
			)
		}
		is AppResolution.Several -> AppOpenAnswer(
			opened = false,
			candidates = resolution.candidates.map { LaunchableApp(label = it.label, `package` = it.packageName) },
		)
		AppResolution.None -> AppOpenAnswer(opened = false)
	}
}

private fun alarmSetBody(context: PhoneCapabilityContext, request: AlarmSetRequest): AlarmSetAnswer {
	val intent = Intent(AlarmClock.ACTION_SET_ALARM).putLaunchExtras(
		alarmExtras(request.hour, request.minutes, request.message),
	)
	return AlarmSetAnswer(set = launchIntent(context, intent))
}

private fun timerSetBody(context: PhoneCapabilityContext, request: TimerSetRequest): TimerSetAnswer {
	val intent = Intent(AlarmClock.ACTION_SET_TIMER).putLaunchExtras(
		timerExtras(request.seconds, request.message),
	)
	return TimerSetAnswer(set = launchIntent(context, intent))
}

/** Checked at the start itself. */
private fun launchIntent(context: PhoneCapabilityContext, intent: Intent): Boolean {
	if (!context.canLaunch()) throw CapabilityUnavailable("not_showing")
	return try {
		context.applicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
		true
	} catch (_: ActivityNotFoundException) {
		throw CapabilityUnavailable("app_missing")
	}
}

private fun Intent.putLaunchExtras(extras: List<LaunchExtra>): Intent {
	for (extra in extras) {
		when (extra) {
			is LaunchExtra.IntExtra -> putExtra(extra.key, extra.value)
			is LaunchExtra.TextExtra -> putExtra(extra.key, extra.value)
			is LaunchExtra.FlagExtra -> putExtra(extra.key, extra.value)
		}
	}
	return this
}
