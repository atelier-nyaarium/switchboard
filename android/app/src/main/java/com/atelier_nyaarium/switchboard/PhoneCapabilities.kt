package com.atelier_nyaarium.switchboard

import android.content.Context
import android.database.Cursor
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract
import com.atelier_nyaarium.switchboard.proto.ContactsSearchAnswer
import com.atelier_nyaarium.switchboard.proto.ContactsSearchRequest
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneContact
import com.atelier_nyaarium.switchboard.proto.PhoneStatusAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneStatusKey
import com.atelier_nyaarium.switchboard.proto.PhoneStatusRequest
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.TorchAnswer
import com.atelier_nyaarium.switchboard.proto.TorchRequest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlin.math.roundToInt

data class CapabilityAvailability(
	val available: Boolean,
	val reason: String? = null,
	val needs: List<String>,
)

internal fun permissionState(
	needs: List<String>,
	hasPermission: (String) -> Boolean,
): CapabilityAvailability {
	val missing = needs.filterNot(hasPermission)
	return if (missing.isEmpty()) {
		CapabilityAvailability(true, needs = needs)
	} else {
		CapabilityAvailability(false, "not_granted", needs)
	}
}

class PhoneCapabilityContext(
	val applicationContext: Context,
	val state: () -> ChatState,
	val self: () -> String,
	val permissionState: (String) -> CapabilityAvailability,
)

class PhoneCapability<Req : Any, Ans : Any>(
	val key: String,
	val kind: String,
	val where: String,
	val needs: List<String>,
	val requestId: String,
	val answerId: String,
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

object PhoneCapabilities {
	val bindings: Map<String, PhoneCapabilityBinding> = listOf(
		bind(
			PhoneCapability(
				key = Protocol.Wire.PhoneCapabilityKey.STATUS,
				kind = "read",
				where = "phone",
				needs = emptyList(),
				requestId = "PhoneStatusRequest",
				answerId = "PhoneStatusAnswer",
				label = "Phone status",
				requestSerializer = PhoneStatusRequest.serializer(),
				answerSerializer = PhoneStatusAnswer.serializer(),
				handler = ::phoneStatus,
			),
		),
		bind(
			PhoneCapability(
				key = Protocol.Wire.PhoneCapabilityKey.CONTACTS_SEARCH,
				kind = "read",
				where = "phone",
				needs = listOf("contacts"),
				requestId = "ContactsSearchRequest",
				answerId = "ContactsSearchAnswer",
				label = "Search contacts",
				requestSerializer = ContactsSearchRequest.serializer(),
				answerSerializer = ContactsSearchAnswer.serializer(),
				handler = ::contactsSearch,
			),
		),
		bind(
			PhoneCapability(
				key = Protocol.Wire.PhoneCapabilityKey.TORCH,
				kind = "act",
				where = "phone",
				needs = emptyList(),
				requestId = "TorchRequest",
				answerId = "TorchAnswer",
				label = "Torch",
				requestSerializer = TorchRequest.serializer(),
				answerSerializer = TorchAnswer.serializer(),
				handler = ::torch,
			),
		),
	).associateBy { it.key }
}

private fun <Req : Any, Ans : Any> bind(capability: PhoneCapability<Req, Ans>): PhoneCapabilityBinding =
	PhoneCapabilityBinding(
		key = capability.key,
		kind = capability.kind,
		where = capability.where,
		needs = capability.needs,
		requestId = capability.requestId,
		answerId = capability.answerId,
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
					PhoneCapabilityAnswer.Unavailable("not_supported")
				},
			)
		},
	)

private suspend fun phoneStatus(context: PhoneCapabilityContext, request: PhoneStatusRequest): PhoneStatusAnswer {
	val now = System.currentTimeMillis()
	val hold = context.state().phoneHold
	// A name, not a key.
	val holder = hold?.label?.takeIf { holdStanding(hold, now) == HoldStanding.HELD }
	val keys = PhoneCapabilities.bindings.values.map { binding ->
		val state = context.permissionState(binding.key)
		PhoneStatusKey(binding.key, state.available, state.reason, state.needs)
	}
	return PhoneStatusAnswer(holder = holder, keys = keys)
}

private suspend fun contactsSearch(
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

private suspend fun torch(context: PhoneCapabilityContext, request: TorchRequest): TorchAnswer {
	val manager = context.applicationContext.getSystemService(CameraManager::class.java)
		?: throw UnsupportedOperationException()
	val id = manager.cameraIdList.firstOrNull { cameraId ->
		val camera = manager.getCameraCharacteristics(cameraId)
		camera.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK &&
			camera.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
	} ?: throw UnsupportedOperationException()
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
