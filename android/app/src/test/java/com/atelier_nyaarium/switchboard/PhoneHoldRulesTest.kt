package com.atelier_nyaarium.switchboard

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
					claimedAt = it["claimedAt"]!!.jsonPrimitive.content.toLong(),
					version = 1L,
				)
			}
			val self = value["self"]!!.jsonPrimitive.content
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
		val hold = PhoneHold(holder = "device-a", claimedAt = 10L, version = 1L)
		assertEquals(false, shouldClaimPhoneHold(HoldClaimTrigger.CONVERSATION, hold, "device-a", 20L))
		assertEquals(false, shouldClaimPhoneHold(HoldClaimTrigger.PANEL, hold, "device-a", 20L))
		assertEquals(false, shouldClaimPhoneHold(HoldClaimTrigger.ASSISTANT_TAB, hold, "device-a", 20L))
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.SEND, hold, "device-a", 20L))
	}

	@Test
	fun openingClaimsWhenThereIsNoCurrentHolder() {
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.CONVERSATION, null, "device-a", 20L))
		assertEquals(true, shouldClaimPhoneHold(HoldClaimTrigger.PANEL, PhoneHold("device-b", 10L, 1L), "device-a", 20L))
	}

	@Test
	fun onlyAStandingSelfHoldAuthorizesPhoneWork() {
		assertEquals(true, isCurrentPhoneHolder(PhoneHold("device-a", 10L, 1L), "device-a", 20L))
		assertEquals(false, isCurrentPhoneHolder(PhoneHold("device-b", 10L, 1L), "device-a", 20L))
		assertEquals(false, isCurrentPhoneHolder(PhoneHold("device-a", 10L, 1L), "device-a", 10L + PHONE_HOLD_WINDOW_MS))
	}

	@Test
	fun aLateClaimAnswerNeverReplacesANewerRow() {
		// Clear at 3, claim at 2.
		assertEquals(true, landsHold(landed = 0L, incoming = 2L))
		assertEquals(true, landsHold(landed = 2L, incoming = 3L))
		assertEquals(false, landsHold(landed = 3L, incoming = 2L))
		assertEquals(false, landsHold(landed = 3L, incoming = 3L))
	}
}
