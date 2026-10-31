package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.HoldClaimResult
import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.PhoneHoldPlane
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal enum class HoldClaimTrigger { CONVERSATION, PANEL, ASSISTANT_TAB, SEND }

internal fun shouldClaimPhoneHold(
	trigger: HoldClaimTrigger,
	hold: PhoneHold?,
	self: String,
	now: Long,
): Boolean = trigger == HoldClaimTrigger.SEND || holdStanding(hold, now) != HoldStanding.HELD || hold?.holder != self

/** Newer rows only. */
internal fun landsHold(landed: Long, incoming: Long): Boolean = incoming > landed

internal interface PhoneHoldRouter {
	suspend fun claim(): PhoneHold?
	suspend fun read(): PhoneHoldPlane?
}

internal class OwnerOpHoldRouter(private val signAndPost: suspend (JsonObject) -> JsonElement?) : PhoneHoldRouter {
	override suspend fun claim(): PhoneHold? = decode(
		signAndPost(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_HOLD_CLAIM) }),
		HoldClaimResult.serializer(),
	)?.hold

	override suspend fun read(): PhoneHoldPlane? = decode(
		signAndPost(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_PHONE_HOLD_READ) }),
		PhoneHoldPlane.serializer(),
	)

	private fun <T> decode(value: JsonElement?, serializer: kotlinx.serialization.KSerializer<T>): T? {
		value ?: return null
		val nested = (value as? JsonObject)?.get("result") ?: value
		return runIsolated { wireJson.decodeFromJsonElement(serializer, nested) }.getOrNull()
	}
}

internal class PhoneHoldOps(
	private val state: MutableStateFlow<ChatState>,
	private val self: () -> String,
	private val router: PhoneHoldRouter?,
	private val scope: CoroutineScope,
	private val clearSpeech: suspend () -> Unit,
	private val now: () -> Long = System::currentTimeMillis,
) : ClearsOnReprovision {
	private val claims = Mutex()
	@Volatile private var provisionalClaim = false
	private var landedVersion = 0L

	fun onConversationShown(team: String) {
		if (team.isBlank()) return
		requestClaim(HoldClaimTrigger.CONVERSATION)
	}

	fun onPanelShown() {
		requestClaim(HoldClaimTrigger.PANEL)
	}

	fun onAssistantShown() {
		requestClaim(HoldClaimTrigger.ASSISTANT_TAB)
	}

	suspend fun beforeSend() {
		claim(HoldClaimTrigger.SEND)
	}

	suspend fun read(): PhoneHoldPlane? = runCatchingCancellable { router?.read() }.getOrNull()

	fun speaks(todayRule: Boolean, at: Long = now()): Boolean =
		speaksFor(state.value.phoneHold, self(), at, todayRule)

	fun alerts(todayRule: Boolean, visible: Boolean, at: Long = now()): Boolean =
		alertsFor(state.value.phoneHold, self(), at, visible, todayRule)

	/** The hold row's version. */
	suspend fun apply(hold: PhoneHold?, version: Long) {
		val lands = synchronized(this) {
			landsHold(landedVersion, version).also { if (it) landedVersion = version }
		}
		if (!lands) return
		state.update { it.copy(phoneHold = hold) }
		provisionalClaim = false
		if (holdStanding(hold, now()) == HoldStanding.HELD && hold?.holder != self()) {
			clearSpeech()
		}
	}

	private fun requestClaim(trigger: HoldClaimTrigger) {
		if (!shouldClaimPhoneHold(trigger, state.value.phoneHold, self(), now())) return
		scope.launch(Dispatchers.IO) { claim(trigger) }
	}

	private suspend fun claim(trigger: HoldClaimTrigger): Boolean {
		if (trigger != HoldClaimTrigger.SEND && provisionalClaim) return true
		if (!shouldClaimPhoneHold(trigger, state.value.phoneHold, self(), now())) return true
		return claims.withLock {
			if (trigger != HoldClaimTrigger.SEND && provisionalClaim) return@withLock true
			if (!shouldClaimPhoneHold(trigger, state.value.phoneHold, self(), now())) return@withLock true
			repeat(CLAIM_ATTEMPTS) { attempt ->
				val answer = runCatchingCancellable { router?.claim() }.getOrNull()
				if (answer != null) {
					apply(answer, answer.version)
					provisionalClaim = true
					return@withLock true
				}
				if (attempt + 1 < CLAIM_ATTEMPTS) delay(CLAIM_RETRY_DELAY_MS)
			}
			false
		}
	}

	override suspend fun clearInMemory() {
		provisionalClaim = false
		synchronized(this) { landedVersion = 0L }
		state.update { it.copy(phoneHold = null) }
	}

	private companion object {
		const val CLAIM_ATTEMPTS = 2
		const val CLAIM_RETRY_DELAY_MS = 300L
	}
}
