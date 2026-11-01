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
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

interface PhoneCapabilityStore {
	fun loadPhoneCapabilityRuns(): String?
	fun savePhoneCapabilityRuns(json: String): Boolean
}

internal const val PHONE_CAPABILITY_RESTART_GRACE_MS = 5 * 60_000L

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
	val retractedUntil: Map<String, Long> = emptyMap(),
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

internal fun answerDeliverySettled(answer: ConsoleClient.ValueAnswer): Boolean = when (answer) {
	is ConsoleClient.ValueAnswer.Answered, is ConsoleClient.ValueAnswer.Refused -> true
	is ConsoleClient.ValueAnswer.Undelivered, ConsoleClient.ValueAnswer.Unreachable -> false
}

private fun validRequestId(value: String): Boolean =
	value.length in 8..64 && value.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' }

internal class PhoneCapabilityJournal(
	private val store: PhoneCapabilityStore,
	private val timer: PhoneCapabilityJournalTimer,
	private val now: () -> Long = System::currentTimeMillis,
) {
	private val lock = Mutex()
	private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
	private val pendingRetractions = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
	private val retractionJobs = java.util.concurrent.ConcurrentHashMap.newKeySet<Job>()
	private var pruneJob: Job? = null
	@Volatile private var blob = load()

	init {
		armPruneTimer(blob, now())
	}

	private fun load(): PhoneCapabilityRunBlob {
		val raw = store.loadPhoneCapabilityRuns() ?: return PhoneCapabilityRunBlob()
		val loaded = runIsolated { json.decodeFromString<PhoneCapabilityRunBlob>(raw) }.getOrDefault(PhoneCapabilityRunBlob())
		val at = now()
		val normalized = loaded.copy(
			retractedUntil = loaded.retracted.associateWith { requestId ->
				loaded.retractedUntil[requestId]
					?: loaded.runs.firstOrNull { it.requestId == requestId }?.let { retentionUntil(it.deadlineAt) }
					?: retentionUntil(at)
			},
		)
		val live = prune(normalized, at)
		if (live != loaded) {
			val saved = runIsolated {
				store.savePhoneCapabilityRuns(json.encodeToString(PhoneCapabilityRunBlob.serializer(), live))
			}.getOrDefault(false)
			if (saved) return live
		}
		return loaded
	}

	private fun persist(next: PhoneCapabilityRunBlob, at: Long): Boolean {
		val live = prune(next, at)
		val saved = runIsolated { store.savePhoneCapabilityRuns(json.encodeToString(PhoneCapabilityRunBlob.serializer(), live)) }
		if (!saved.getOrDefault(false)) return false
		blob = live
		armPruneTimer(live, at)
		return true
	}

	private fun armPruneTimer(source: PhoneCapabilityRunBlob, at: Long) {
		pruneJob?.cancel()
		pruneJob = null
		val cutoff = (source.runs.map { retentionUntil(it.deadlineAt) } + source.retracted.map { requestId ->
			source.retractedUntil[requestId]
				?: source.runs.firstOrNull { it.requestId == requestId }?.let { retentionUntil(it.deadlineAt) }
				?: retentionUntil(at)
		}).minOrNull() ?: return
		if (cutoff == Long.MAX_VALUE) return
		val waitMs = if (cutoff <= at) 1_000L else cutoff - at + 1L
		pruneJob = timer.schedule(waitMs) {
			pruneExpired()
		}
	}

	private suspend fun pruneExpired() = lock.withLock {
		pruneJob = null
		val at = now()
		val live = prune(blob, at)
		if (live != blob) {
			if (!persist(live, at)) armPruneTimer(blob, at)
		} else {
			armPruneTimer(blob, at)
		}
	}

	private fun prune(source: PhoneCapabilityRunBlob, at: Long): PhoneCapabilityRunBlob {
		val retractedUntil = source.retracted.mapNotNull { requestId ->
			val until = source.retractedUntil[requestId]
				?: source.runs.firstOrNull { it.requestId == requestId }?.let { retentionUntil(it.deadlineAt) }
				?: retentionUntil(at)
			if (at <= until) requestId to until else null
		}.toMap()
		return source.copy(
			runs = source.runs.filter { at <= retentionUntil(it.deadlineAt) },
			retracted = retractedUntil.keys,
			retractedUntil = retractedUntil,
		)
	}

	private fun retentionUntil(deadlineAt: Long): Long =
		if (deadlineAt > Long.MAX_VALUE - PHONE_CAPABILITY_RESTART_GRACE_MS) Long.MAX_VALUE
		else deadlineAt + PHONE_CAPABILITY_RESTART_GRACE_MS

	suspend fun begin(gatewayId: String, team: String, row: PhoneCapabilityRow): PhoneCapabilityRunStart = lock.withLock {
		val at = now()
		val current = prune(blob, at)
		val existing = current.runs.firstOrNull { it.requestId == row.requestId }
		if (existing?.answer != null) return@withLock PhoneCapabilityRunStart.Existing(existing)
		if (row.requestId in pendingRetractions || row.requestId in current.retracted) return@withLock PhoneCapabilityRunStart.Retracted
		if (existing != null) return@withLock PhoneCapabilityRunStart.Existing(existing)
		if (row.deadlineAt <= at) {
			if (current != blob) persist(current, at)
			return@withLock PhoneCapabilityRunStart.NotStored
		}
		val started = PhoneCapabilityRun(row.requestId, row.key, gatewayId, team, row.deadlineAt)
		if (persist(current.copy(runs = current.runs + started), at)) PhoneCapabilityRunStart.Started(started) else PhoneCapabilityRunStart.NotStored
	}

	suspend fun answer(requestId: String, answer: PhoneCapabilityAnswer): PhoneCapabilityRun? = lock.withLock {
		val at = now()
		val live = prune(blob, at)
		val current = live.runs.firstOrNull { it.requestId == requestId }
		if (current == null) {
			if (live != blob) persist(live, at)
			return@withLock null
		}
		if (current.answer != null) return@withLock current
		val next = current.copy(answer = answer)
		if (persist(live.copy(runs = live.runs.map { if (it.requestId == requestId) next else it }), at)) next else null
	}

	suspend fun runUnlessRetracted(
		requestId: String,
		action: suspend () -> PhoneCapabilityAnswer,
	): PhoneCapabilityAnswer? {
		if (isRetracted(requestId)) return null
		return action()
	}

	suspend fun isRetracted(requestId: String): Boolean {
		if (requestId in pendingRetractions) return true
		return lock.withLock {
			val at = now()
			val live = prune(blob, at)
			if (live != blob) persist(live, at)
			requestId in pendingRetractions || requestId in live.retracted
		}
	}

	suspend fun markDelivered(requestId: String): PhoneCapabilityRun? = lock.withLock {
		val at = now()
		val live = prune(blob, at)
		val current = live.runs.firstOrNull { it.requestId == requestId }
		if (current == null) {
			if (live != blob) persist(live, at)
			return@withLock null
		}
		if (current.delivered) return@withLock current
		val next = current.copy(delivered = true)
		if (persist(live.copy(runs = live.runs.map { if (it.requestId == requestId) next else it }), at)) next else null
	}

	suspend fun retract(requestId: String) = lock.withLock {
		val at = now()
		val live = prune(blob, at)
		if (requestId in live.retracted) {
			val saved = live == blob || persist(live, at)
			if (saved) pendingRetractions.remove(requestId)
			return@withLock
		}
		val until = live.runs.firstOrNull { it.requestId == requestId }?.let { retentionUntil(it.deadlineAt) }
			?: retentionUntil(at)
		if (persist(
			live.copy(
				retracted = live.retracted + requestId,
				retractedUntil = live.retractedUntil + (requestId to until),
			),
			at,
		)) pendingRetractions.remove(requestId)
	}

	fun scheduleRetraction(requestId: String, scope: CoroutineScope) {
		if (!validRequestId(requestId)) return
		pendingRetractions.add(requestId)
		val job = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) { retract(requestId) }
		retractionJobs.add(job)
		job.invokeOnCompletion { retractionJobs.remove(job) }
		job.start()
	}

	suspend fun all(): List<PhoneCapabilityRun> = lock.withLock {
		val at = now()
		val live = prune(blob, at)
		if (live != blob) persist(live, at)
		live.runs.filter { it.answer != null || (it.requestId !in live.retracted && it.requestId !in pendingRetractions) }
	}

	suspend fun clear(): Boolean {
		retractionJobs.toList().forEach { it.cancel() }
		retractionJobs.clear()
		pendingRetractions.clear()
		return lock.withLock {
			pruneJob?.cancel()
			pruneJob = null
			val empty = PhoneCapabilityRunBlob()
			blob = empty
			runIsolated { store.savePhoneCapabilityRuns(json.encodeToString(PhoneCapabilityRunBlob.serializer(), empty)) }
				.getOrDefault(false)
		}
	}
}

internal fun interface PhoneCapabilityJournalTimer {
	fun schedule(delayMs: Long, task: suspend () -> Unit): Job
}

internal class PhoneCapabilityOps(
	private val context: Context,
	private val state: () -> ChatState,
	private val self: () -> HoldSelf,
	private val scope: CoroutineScope,
	private val store: PhoneCapabilityStore,
	private val client: () -> ConsoleClient?,
	private val now: () -> Long = System::currentTimeMillis,
) : ClearsOnReprovision {
	private data class Action(val gatewayId: String, val team: String, val row: PhoneCapabilityRow)

	private val journal = PhoneCapabilityJournal(
		store = store,
		timer = PhoneCapabilityJournalTimer { delayMs, task ->
			scope.launch(Dispatchers.IO) {
				delay(delayMs)
				task()
			}
		},
		now = now,
	)
	private val events = Channel<Action>(Channel.UNLIMITED)
	private val deliveryJobs = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.Job>()
	@Volatile private var worker: kotlinx.coroutines.Job? = null
	private val permissionContext = PhoneCapabilityContext(
		applicationContext = context.applicationContext,
		state = state,
		self = { self().key },
		permissionState = ::permissionState,
	)

	@Synchronized
	fun start() {
		if (worker?.isActive == true) return
		worker = scope.launch(Dispatchers.IO) {
			resumePending()
			for (event in events) {
				process(event)
			}
		}
	}

	fun enqueue(gatewayId: String, team: String, row: PhoneCapabilityRow) {
		start()
		if (gatewayId.isBlank() || team.isBlank() || !validPhoneCapabilityRow(row)) {
			CapabilityLog.record(row.key, CapabilityLogEvent.IGNORED, accepted = false)
			return
		}
		if (events.trySend(Action(gatewayId, team, row)).isSuccess) {
			CapabilityLog.record(row.key, CapabilityLogEvent.QUEUED)
		}
	}

	fun retract(requestId: String) {
		journal.scheduleRetraction(requestId, scope)
		start()
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

	private suspend fun process(event: Action) {
		when (val started = journal.begin(event.gatewayId, event.team, event.row)) {
			PhoneCapabilityRunStart.Retracted, PhoneCapabilityRunStart.NotStored -> return
			is PhoneCapabilityRunStart.Existing -> {
				val run = started.run
				val answer = run.answer ?: PhoneCapabilityAnswer.Unavailable("timeout")
				val settled = if (run.answer == null) journal.answer(run.requestId, answer) else run
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
					val result = journal.runUnlessRetracted(run.requestId) {
						runBinding(binding, row, run.deadlineAt)
					} ?: return
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
					val result = console.sendValueAnswer(
						run.gatewayId,
						ConsoleOp.PhoneCapabilityAnswer(run.requestId, answer),
						run.requestId,
					)
					answerDeliverySettled(result)
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
