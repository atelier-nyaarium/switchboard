package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneTelephonyRulesTest {
	@Test
	fun phoneNumbersNormalizeSeparatorsAndRejectLettersAndEmptyValues() {
		assertEquals("+14155550100", phoneNumberOf(" +1 (415)-555.0100 "))
		assertNull(phoneNumberOf("555-CALL"))
		assertNull(phoneNumberOf(""))
		assertNull(phoneNumberOf("+"))
		assertNull(phoneNumberOf("1".repeat(41)))
	}

	@Test
	fun phoneUrisUseSmsAndEncodedTelSchemes() {
		assertEquals("smsto:+14155550100", smsUri("+14155550100"))
		assertEquals("tel:%2B14155550100", telUri("+14155550100"))
	}

	@Test
	fun smsBodiesTrimAndCapAtOneThousandCharacters() {
		assertNull(smsBodyOf("  \n "))
		assertEquals("text", smsBodyOf(" text "))
		assertEquals(1000, smsBodyOf("x".repeat(1005))?.length)
	}

	@Test
	fun smsPartsUseGsmAndUcs2Limits() {
		assertEquals(1, smsParts("Short text"))
		assertEquals(1, smsParts("a".repeat(160)))
		assertEquals(2, smsParts("a".repeat(161)))
		assertEquals(2, smsParts("漢".repeat(71)))
		assertEquals(2, smsParts("ÆæßÉ".repeat(41)))
		assertEquals(1, smsParts("{".repeat(80)))
		assertEquals(2, smsParts("{".repeat(81)))
		assertEquals(1, smsParts("a" + Char(0x0c).toString().repeat(71) + "b"))
	}
}
