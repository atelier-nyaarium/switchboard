package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.HoldClaimResult
import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.PhoneHoldPlane
import com.atelier_nyaarium.switchboard.proto.PlaneLineage
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
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
	self: HoldSelf?,
	now: Long,
): Boolean =
	trigger == HoldClaimTrigger.SEND ||
		holdStanding(hold, now) != HoldStanding.HELD ||
		self?.holds(hold?.holder) != true

internal interface PhoneHoldRouter {
	suspend fun claim(): HoldClaimResult?
}

internal class OwnerOpHoldRouter(private val signAndPost: suspend (JsonObject) -> JsonElement?) : PhoneHoldRouter {
	override suspend fun claim(): HoldClaimResult? = ownerOpResult(
		signAndPost(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_HOLD_CLAIM) }),
		HoldClaimResult.serializer(),
	)

	suspend fun read(): PhoneHoldPlane? = ownerOpResult(
		signAndPost(buildJsonObject { put("kind", Protocol.Wire.OWNER_OP_PHONE_HOLD_READ) }),
		PhoneHoldPlane.serializer(),
	)
}

internal class PhoneHoldOps(
	private val state: MutableStateFlow<ChatState>,
	private val self: () -> HoldSelf?,
	private val router: PhoneHoldRouter?,
	private val applyPlane: suspend (PlaneLineage, JsonElement) -> Unit,
	private val pullPlanes: suspend () -> Unit,
	private val scope: CoroutineScope,
	private val clearSpeech: suspend () -> Unit,
	private val now: () -> Long = System::currentTimeMillis,
) : ClearsOnReprovision {
	private val claims = Mutex()

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

	fun speaks(todayRule: Boolean, at: Long = now()): Boolean =
		speaksFor(state.value.phoneHold, self(), at, todayRule)

	fun alerts(todayRule: Boolean, visible: Boolean, at: Long = now()): Boolean =
		alertsFor(state.value.phoneHold, self(), at, visible, todayRule)

	suspend fun apply(hold: PhoneHold?): Boolean {
		state.update { it.copy(phoneHold = hold) }
		if (isHeldByAnother(hold, self(), now())) {
			clearSpeech()
		}
		return true
	}

	private fun requestClaim(trigger: HoldClaimTrigger) {
		if (!shouldClaimPhoneHold(trigger, state.value.phoneHold, self(), now())) return
		scope.launch(Dispatchers.IO) { claim(trigger) }
	}

	private suspend fun claim(trigger: HoldClaimTrigger): Boolean {
		if (!shouldClaimPhoneHold(trigger, state.value.phoneHold, self(), now())) return true
		return claims.withLock {
			if (!shouldClaimPhoneHold(trigger, state.value.phoneHold, self(), now())) return@withLock true
			repeat(CLAIM_ATTEMPTS) { attempt ->
				val answer = runCatchingCancellable { router?.claim() }.getOrNull()
				if (answer != null) {
					land(answer)
					return@withLock true
				}
				if (attempt + 1 < CLAIM_ATTEMPTS) delay(CLAIM_RETRY_DELAY_MS)
			}
			false
		}
	}

	private fun land(answer: HoldClaimResult) {
		val lineage = answer.lineage
		if (lineage == null) {
			scope.launch(Dispatchers.IO) { runCatchingCancellable { pullPlanes() } }
			return
		}
		val payload = wireJson.encodeToJsonElement(
			PhoneHoldPlane.serializer(),
			PhoneHoldPlane(version = answer.hold.version, hold = answer.hold),
		)
		scope.launch(Dispatchers.IO) { runCatchingCancellable { applyPlane(lineage, payload) } }
	}

	override suspend fun clearInMemory() {
		state.update { it.copy(phoneHold = null) }
	}

	private companion object {
		const val CLAIM_ATTEMPTS = 2
		const val CLAIM_RETRY_DELAY_MS = 300L
	}
}
