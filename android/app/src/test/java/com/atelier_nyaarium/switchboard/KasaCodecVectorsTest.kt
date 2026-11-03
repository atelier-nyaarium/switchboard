package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Drives the codec twin through the vectors src/__tests__/kasa-vectors.test.ts pins. */
class KasaCodecVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("kasa-codec/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["vectors"]!!.jsonArray

	private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

	private fun bytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

	@Test
	fun framesMatchTheGatewayCodecByteForByte() {
		for (vector in vectors) {
			val plaintext = vector.jsonObject["plaintext"]!!.jsonPrimitive.content
			val frame = vector.jsonObject["frame"]!!.jsonPrimitive.content
			assertEquals(plaintext, frame, hex(KasaCodec.frame(plaintext)))
			assertEquals(plaintext, KasaCodec.unframe(bytes(frame)))
		}
	}

	@Test
	fun aFrameWhoseLengthDisagreesIsRefused() {
		val good = KasaCodec.frame("{}")
		assertThrows(IllegalArgumentException::class.java) { KasaCodec.unframe(good.copyOf(good.size - 1)) }
		assertThrows(IllegalArgumentException::class.java) { KasaCodec.unframe(byteArrayOf(0, 0)) }
	}
}
