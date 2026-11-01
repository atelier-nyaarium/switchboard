package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.PhoneHold
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneHoldRulesTest {
	private val cases = Json.parseToJsonElement(
		javaClass.classLoader!!.getResourceAsStream("phone-hold/vectors.json")!!.bufferedReader().readText(),
	).jsonObject["cases"]!!.jsonArray

	@Test
	fun thePhoneMatchesTheSharedHoldRules() {
		for (case in cases) {
			val value = case.jsonObject
			val holdValue = value["hold"]?.takeUnless { it.toString() == "null" }?.jsonObject
			val hold = holdValue?.let {
				PhoneHold(
					holder = it["holder"]!!.jsonPrimitive.content,
					label = "Pixel",
					claimedAt = it["claimedAt"]!!.jsonPrimitive.content.toLong(),
					version = 1L,
				)
			}
			val self = holdSelf(value["self"]!!.jsonPrimitive.content)
			val now = value["now"]!!.jsonPrimitive.content.toLong()
			val visible = value["visible"]!!.jsonPrimitive.content.toBoolean()
			val todayRule = value["todayRule"]!!.jsonPrimitive.content.toBoolean()
			val expected = value["expect"]!!.jsonObject

			assertEquals(value["name"]!!.jsonPrimitive.content, expected["standing"]!!.jsonPrimitive.content.uppercase(), holdStanding(hold, now).name)
			assertEquals(value["name"]!!.jsonPrimitive.content, expected["speaks"]!!.jsonPrimitive.content.toBoolean(), speaksFor(hold, self, now, todayRule))
			assertEquals(value["name"]!!.jsonPrimitive.content, expected["alerts"]!!.jsonPrimitive.content.toBoolean(), alertsFor(hold, self, now, visible, todayRule))
		}
	}

	@Test
	fun onlySendReclaimsAnAlreadyHeldPhone() {
		val self = holdSelf("key-a")
		val hold = hold("key-a", 10L, 1L)
		assertEquals(false, shouldClaimPhoneHold(HoldClaimTrigger.CONVERSATION, hold, self, 20L))
		assertEquals(false, shouldClaimPhoneHold(HoldClaimTrigger.PANEL, hold, self, 20L))
		assertEquals(false, shouldClaimPhoneHold(HoldClaimTrigger.ASSISTANT_TAB, hold, self, 20L))
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.SEND, hold, self, 20L))
	}

	@Test
	fun openingClaimsWhenThereIsNoCurrentHolder() {
		val self = holdSelf("key-a")
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.CONVERSATION, null, self, 20L))
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.PANEL, hold("key-b", 10L, 1L), self, 20L))
	}

	@Test
	fun onlyAStandingSelfHoldAuthorizesPhoneWork() {
		val self = holdSelf("key-a")
		assertEquals(true, isCurrentPhoneHolder(hold("key-a", 10L, 1L), self, 20L))
		assertEquals(false, isCurrentPhoneHolder(hold("key-b", 10L, 1L), self, 20L))
		assertEquals(false, isCurrentPhoneHolder(hold("key-a", 10L, 1L), self, 10L + PHONE_HOLD_WINDOW_MS))
	}

	@Test
	fun holdRulesCompareTheSigningKeyNotTheDisplayLabel() {
		val hold = PhoneHold("console-key-a", "Pixel 10 Pro XL", 10L, 1L)
		val self = holdSelf("console-key-a")

		assertEquals(true, speaksFor(hold, self, 20L, todayRule = false))
		assertEquals(true, alertsFor(hold, self, 20L, visible = false, todayRule = false))
		assertEquals(false, isHeldByAnother(hold, self, 20L))
	}

	@Test
	fun holdLapseUsesTheHoldWindow() {
		assertEquals(null, holdLapseAt(null))
		assertEquals(10L + PHONE_HOLD_WINDOW_MS, holdLapseAt(hold("key-a", 10L, 1L)))
	}

	private fun hold(holder: String, claimedAt: Long, version: Long) = PhoneHold(holder, "Pixel", claimedAt, version)

	@Test
	fun aMissingIdentityNeverMatchesAndAStandingHoldBelongsToAnotherPhone() {
		val hold = hold("key-a", 10L, 1L)

		assertEquals(false, isCurrentPhoneHolder(hold, null, 20L))
		assertEquals(true, isHeldByAnother(hold, null, 20L))
		assertEquals(false, isHeldByAnother(hold, null, 10L + PHONE_HOLD_WINDOW_MS))
		assertEquals(false, isHeldByAnother(null, null, 20L))
		assertEquals(false, speaksFor(hold, null, 20L, todayRule = false))
		assertEquals(false, alertsFor(hold, null, 20L, visible = false, todayRule = false))
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.CONVERSATION, hold, null, 20L))
	}

	private fun holdSelf(key: String): HoldSelf = HoldSelf.of(
		Crypto.Identity(Crypto.KeyPairRaw(key, ""), Crypto.KeyPairRaw("", "")),
	)
}
