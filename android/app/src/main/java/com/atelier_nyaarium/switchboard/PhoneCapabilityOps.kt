package com.atelier_nyaarium.switchboard

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneCapabilityRow
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

interface PhoneCapabilityStore {
	fun loadPhoneCapabilityRuns(): String?
	fun savePhoneCapabilityRuns(json: String): Boolean
}

@Serializable
internal data class PhoneCapabilityRun(
	val requestId: String,
	val key: String,
	val gatewayId: String,
	val team: String,
	val deadlineAt: Long,
	val answer: PhoneCapabilityAnswer? = null,
	val delivered: Boolean = false,
)

@Serializable
private data class PhoneCapabilityRunBlob(
	val runs: List<PhoneCapabilityRun> = emptyList(),
	val retracted: Set<String> = emptySet(),
)

internal sealed interface PhoneCapabilityRunStart {
	data class Started(val run: PhoneCapabilityRun) : PhoneCapabilityRunStart
	data class Existing(val run: PhoneCapabilityRun) : PhoneCapabilityRunStart
	data object Retracted : PhoneCapabilityRunStart
	data object NotStored : PhoneCapabilityRunStart
}

internal enum class CapabilityRunDecision { START, REPLAY, TIMEOUT }

internal fun capabilityRunDecision(run: PhoneCapabilityRun?): CapabilityRunDecision = when {
	run == null -> CapabilityRunDecision.START
	run.answer != null -> CapabilityRunDecision.REPLAY
	else -> CapabilityRunDecision.TIMEOUT
}

internal fun validPhoneCapabilityRow(row: PhoneCapabilityRow): Boolean =
	validRequestId(row.requestId) && row.key.isNotBlank() && row.key.length <= 64 &&
		row.deadlineAt >= 0L && row.guard in setOf("approved", "unasked", "none")

/** Only silence retries. */
internal fun answeredByGateway(ok: Boolean?): Boolean = ok != null

private fun validRequestId(value: String): Boolean =
	value.length in 8..64 && value.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' }

internal class PhoneCapabilityJournal(private val store: PhoneCapabilityStore) {
	private val lock = Mutex()
	private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
	@Volatile private var blob = load()

	private fun load(): PhoneCapabilityRunBlob {
		val raw = store.loadPhoneCapabilityRuns() ?: return PhoneCapabilityRunBlob()
		return runIsolated { json.decodeFromString<PhoneCapabilityRunBlob>(raw) }.getOrDefault(PhoneCapabilityRunBlob())
	}

	private fun persist(next: PhoneCapabilityRunBlob): Boolean {
		val saved = runIsolated { store.savePhoneCapabilityRuns(json.encodeToString(PhoneCapabilityRunBlob.serializer(), next)) }
		if (saved.getOrDefault(false)) blob = next
		return saved.getOrDefault(false)
	}

	suspend fun begin(gatewayId: String, team: String, row: PhoneCapabilityRow): PhoneCapabilityRunStart = lock.withLock {
		if (row.requestId in blob.retracted) return@withLock PhoneCapabilityRunStart.Retracted
		val existing = blob.runs.firstOrNull { it.requestId == row.requestId }
		if (existing != null) return@withLock PhoneCapabilityRunStart.Existing(existing)
		val started = PhoneCapabilityRun(row.requestId, row.key, gatewayId, team, row.deadlineAt)
		if (persist(blob.copy(runs = blob.runs + started))) PhoneCapabilityRunStart.Started(started) else PhoneCapabilityRunStart.NotStored
	}

	suspend fun answer(requestId: String, answer: PhoneCapabilityAnswer): PhoneCapabilityRun? = lock.withLock {
		val current = blob.runs.firstOrNull { it.requestId == requestId } ?: return@withLock null
		if (current.answer != null) return@withLock current
		val next = current.copy(answer = answer)
		if (persist(blob.copy(runs = blob.runs.map { if (it.requestId == requestId) next else it }))) next else null
	}

	suspend fun markDelivered(requestId: String): PhoneCapabilityRun? = lock.withLock {
		val current = blob.runs.firstOrNull { it.requestId == requestId } ?: return@withLock null
		if (current.delivered) return@withLock current
		val next = current.copy(delivered = true)
		if (persist(blob.copy(runs = blob.runs.map { if (it.requestId == requestId) next else it }))) next else null
	}

	suspend fun retract(requestId: String) = lock.withLock {
		if (requestId in blob.retracted) return@withLock
		persist(blob.copy(retracted = blob.retracted + requestId))
	}

	suspend fun all(): List<PhoneCapabilityRun> = lock.withLock { blob.runs }

	suspend fun clear() = lock.withLock {
		val empty = PhoneCapabilityRunBlob()
		blob = empty
		runIsolated { store.savePhoneCapabilityRuns(json.encodeToString(PhoneCapabilityRunBlob.serializer(), empty)) }
			.getOrDefault(false)
	}
}

internal class PhoneCapabilityOps(
	private val context: Context,
	private val state: () -> ChatState,
	private val self: () -> String,
	private val scope: CoroutineScope,
	private val store: PhoneCapabilityStore,
	private val client: () -> ConsoleClient?,
	private val now: () -> Long = System::currentTimeMillis,
) : ClearsOnReprovision {
	private sealed interface Event {
		data class Action(val gatewayId: String, val team: String, val row: PhoneCapabilityRow) : Event
		data class Retract(val requestId: String) : Event
	}

	private val journal = PhoneCapabilityJournal(store)
	private val events = Channel<Event>(Channel.UNLIMITED)
	private val deliveryJobs = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.Job>()
	@Volatile private var worker: kotlinx.coroutines.Job? = null
	private val permissionContext = PhoneCapabilityContext(
		applicationContext = context.applicationContext,
		state = state,
		self = self,
		permissionState = ::permissionState,
	)

	@Synchronized
	fun start() {
		if (worker?.isActive == true) return
		worker = scope.launch(Dispatchers.IO) {
			resumePending()
			for (event in events) {
				when (event) {
					is Event.Action -> process(event)
					is Event.Retract -> journal.retract(event.requestId)
				}
			}
		}
	}

	fun enqueue(gatewayId: String, team: String, row: PhoneCapabilityRow) {
		start()
		if (gatewayId.isBlank() || team.isBlank() || !validPhoneCapabilityRow(row)) {
			CapabilityLog.record(row.key, CapabilityLogEvent.IGNORED, accepted = false)
			return
		}
		if (events.trySend(Event.Action(gatewayId, team, row)).isSuccess) {
			CapabilityLog.record(row.key, CapabilityLogEvent.QUEUED)
		}
	}

	fun retract(requestId: String) {
		start()
		if (validRequestId(requestId)) events.trySend(Event.Retract(requestId))
	}

	fun permissionState(key: String): CapabilityAvailability {
		val binding = PhoneCapabilities.bindings[key]
			?: return CapabilityAvailability(false, "not_supported", emptyList())
		val availability = permissionState(binding.needs) { permission ->
			val manifestPermission = when (permission) {
				"contacts" -> Manifest.permission.READ_CONTACTS
				"calendar" -> Manifest.permission.READ_CALENDAR
				"send_sms" -> Manifest.permission.SEND_SMS
				"call_phone" -> Manifest.permission.CALL_PHONE
				"notifications" -> Manifest.permission.POST_NOTIFICATIONS
				else -> return@permissionState false
			}
			runIsolated { context.checkSelfPermission(manifestPermission) == PackageManager.PERMISSION_GRANTED }.getOrDefault(false)
		}
		if (!availability.available || key != Protocol.Wire.PhoneCapabilityKey.TORCH) return availability
		return if (hasTorch()) availability else CapabilityAvailability(false, "not_supported", binding.needs)
	}

	private fun hasTorch(): Boolean = runIsolated {
		val manager = context.getSystemService(android.hardware.camera2.CameraManager::class.java)
			?: return@runIsolated false
		manager.cameraIdList.any { cameraId ->
			val camera = manager.getCameraCharacteristics(cameraId)
			camera.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING) == android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK &&
				camera.get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
		}
	}.getOrDefault(false)

	override suspend fun clearInMemory() {
		deliveryJobs.values.forEach { it.cancel() }
		deliveryJobs.clear()
		while (events.tryReceive().isSuccess) Unit
		journal.clear()
	}

	private suspend fun resumePending() {
		for (run in journal.all()) {
			val answer = run.answer ?: PhoneCapabilityAnswer.Unavailable("timeout")
			val settled = if (run.answer == null) journal.answer(run.requestId, answer) else run
			if (settled != null && !settled.delivered) deliver(settled)
		}
	}

	private suspend fun process(event: Event.Action) {
		when (val started = journal.begin(event.gatewayId, event.team, event.row)) {
			PhoneCapabilityRunStart.Retracted, PhoneCapabilityRunStart.NotStored -> return
			is PhoneCapabilityRunStart.Existing -> {
				val run = started.run
				val answer = run.answer ?: PhoneCapabilityAnswer.Unavailable("timeout")
				val settled = if (run.answer == null) journal.answer(run.requestId, answer) else run
				// New row, new attempt.
				if (settled != null) deliver(settled.copy(gatewayId = event.gatewayId, team = event.team), resend = true)
				CapabilityLog.record(event.row.key, CapabilityLogEvent.REPLAYED)
				return
			}
			is PhoneCapabilityRunStart.Started -> execute(started.run, event.row)
		}
	}

	private suspend fun execute(run: PhoneCapabilityRun, row: PhoneCapabilityRow) {
		CapabilityLog.record(run.key, CapabilityLogEvent.STARTED)
		val answer = when {
			now() >= run.deadlineAt -> PhoneCapabilityAnswer.Unavailable("timeout")
			!isCurrentPhoneHolder(state().phoneHold, self(), now()) -> PhoneCapabilityAnswer.Unavailable("no_holder")
			PhoneCapabilities.bindings[run.key] == null -> PhoneCapabilityAnswer.Unavailable("not_supported")
			else -> {
				val permission = permissionState(run.key)
				if (!permission.available) {
					CapabilityLog.record(run.key, CapabilityLogEvent.DENIED, permission.needs.size, false)
					PhoneCapabilityAnswer.Unavailable(permission.reason ?: "not_granted", permission.needs)
				} else {
					val binding = PhoneCapabilities.bindings.getValue(run.key)
					val result = runBinding(binding, row, run.deadlineAt)
					if (binding.kind == "act" && result is PhoneCapabilityAnswer.Ok) postTrace(binding.label, run.requestId)
					result
				}
			}
		}
		val saved = journal.answer(run.requestId, answer)
		if (saved == null) {
			CapabilityLog.record(run.key, CapabilityLogEvent.FAILED, accepted = false)
			return
		}
		CapabilityLog.record(run.key, CapabilityLogEvent.ANSWERED, accepted = answer is PhoneCapabilityAnswer.Ok)
		if (!saved.delivered) deliver(saved)
	}

	private suspend fun runBinding(binding: PhoneCapabilityBinding, row: PhoneCapabilityRow, deadlineAt: Long): PhoneCapabilityAnswer =
		try {
			withTimeout((deadlineAt - now()).coerceAtLeast(1L)) { binding.run(permissionContext, row.params) }
		} catch (_: TimeoutCancellationException) {
			PhoneCapabilityAnswer.Unavailable("timeout")
		}

	private suspend fun deliver(run: PhoneCapabilityRun, resend: Boolean = false) {
		if (run.delivered && !resend) return
		if (deliveryJobs.containsKey(run.requestId)) return
		val job = scope.launch(Dispatchers.IO) {
			while (now() <= run.deadlineAt) {
				val answer = run.answer ?: return@launch
				val sent = runCatchingCancellable {
					val console = client() ?: return@runCatchingCancellable false
					val result = console.sendValueOp(
						run.gatewayId,
						ConsoleOp.PhoneCapabilityAnswer(run.requestId, answer),
						run.requestId,
					) as? JsonObject
					answeredByGateway(result?.get("ok")?.jsonPrimitive?.booleanOrNull)
				}.getOrDefault(false)
				if (sent) {
					journal.markDelivered(run.requestId)
					return@launch
				}
				delay(ANSWER_RETRY_MS)
			}
			CapabilityLog.record(run.key, CapabilityLogEvent.FAILED, accepted = false)
		}.also { deliveryJobs[run.requestId] = it }
		job.invokeOnCompletion { deliveryJobs.remove(run.requestId, job) }
	}

	private fun postTrace(label: String, requestId: String) {
		runIsolated {
			val manager = context.getSystemService(NotificationManager::class.java)
				?: return@runIsolated
			manager.createNotificationChannel(
				NotificationChannel(TRACE_CHANNEL, "Assistant acts", NotificationManager.IMPORTANCE_DEFAULT).apply {
					lockscreenVisibility = Notification.VISIBILITY_PRIVATE
				},
			)
			val public = NotificationCompat.Builder(context, TRACE_CHANNEL)
				.setSmallIcon(android.R.drawable.stat_notify_chat)
				.setContentTitle(ASSISTANT_GENERIC_LINE)
				.build()
			val note = NotificationCompat.Builder(context, TRACE_CHANNEL)
				.setSmallIcon(android.R.drawable.stat_notify_chat)
				.setContentTitle(label)
				.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
				.setPublicVersion(public)
				.setAutoCancel(true)
				.build()
			NotificationManagerCompat.from(context).notify(traceId(requestId), note)
		}.onFailure { CapabilityLog.record("trace", CapabilityLogEvent.FAILED, accepted = false) }
	}

	private companion object {
		const val ANSWER_RETRY_MS = 1_000L
		const val TRACE_CHANNEL = "assistant_acts"
		const val TRACE_ID_BASE = 6_000_000

		fun traceId(requestId: String): Int = TRACE_ID_BASE + (requestId.hashCode() and 0x000FFFFF)
	}
}
