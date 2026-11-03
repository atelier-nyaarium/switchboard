package com.atelier_nyaarium.switchboard

import java.nio.ByteBuffer

/** Twin of the Gateway's Kasa codec; `tests/fixtures/kasa-codec/vectors.json` pins both. */
internal object KasaCodec {
	private const val START_KEY = 0xab

	fun encrypt(plaintext: String): ByteArray {
		val input = plaintext.toByteArray(Charsets.UTF_8)
		val output = ByteArray(input.size)
		var key = START_KEY
		for (index in input.indices) {
			val cipher = (input[index].toInt() and 0xff) xor key
			output[index] = cipher.toByte()
			key = cipher
		}
		return output
	}

	fun decrypt(ciphertext: ByteArray): String {
		val output = ByteArray(ciphertext.size)
		var key = START_KEY
		for (index in ciphertext.indices) {
			val cipher = ciphertext[index].toInt() and 0xff
			output[index] = (cipher xor key).toByte()
			key = cipher
		}
		return Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(output)).toString()
	}

	fun frame(plaintext: String): ByteArray {
		val body = encrypt(plaintext)
		return ByteBuffer.allocate(4 + body.size).putInt(body.size).put(body).array()
	}

	/** Refuses a frame whose length disagrees with its payload. */
	fun unframe(packet: ByteArray): String {
		require(packet.size >= 4) { "Kasa frame is missing its length" }
		val length = ByteBuffer.wrap(packet, 0, 4).int
		require(length >= 0 && packet.size == length + 4) { "Kasa frame length does not match its payload" }
		return decrypt(packet.copyOfRange(4, packet.size))
	}
}
