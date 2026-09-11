package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Protocol
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/** Shared fixture corpus pins byte-for-byte TypeScript agreement. */
class SealedBlobVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	@Test
	fun opensEveryVectorTheTypeScriptSideSealed() {
		val root = json
			.parseToJsonElement(
				javaClass.classLoader!!.getResourceAsStream("sealed-blob/vectors.json")!!.bufferedReader().readText(),
			)
			.jsonObject
		val key = Base64.getDecoder().decode(root["key"]!!.jsonPrimitive.content)
		val ctx = root["context"]!!.jsonObject
		val context = BlobSealContext(
			domainId = ctx["domainId"]!!.jsonPrimitive.content,
			ownerSignPub = ctx["ownerSignPub"]!!.jsonPrimitive.content,
			epoch = ctx["epoch"]!!.jsonPrimitive.content.toInt(),
			blobId = ctx["blobId"]!!.jsonPrimitive.content,
		)

		assertEquals(
			root["aadSample"]!!.jsonPrimitive.content,
			Base64.getEncoder().encodeToString(blobChunkAad(context, 0, true).bytes()),
		)

		for (case in root["cases"]!!.jsonArray) {
			val size = case.jsonObject["size"]!!.jsonPrimitive.content.toLong()
			assertEquals(
				case.jsonObject["ciphertextSize"]!!.jsonPrimitive.content.toLong(),
				sealedBlobSize(size),
			)
			val frames = case.jsonObject["frames"]!!.jsonArray
				.map { Base64.getDecoder().decode(it.jsonPrimitive.content) }
			val ciphertext = frames.reduce { a, b -> a + b }
			val opened = openSealedBlobRange(ciphertext, 0L, size, context.epoch, 0L, size, key, context.domainId, context.ownerSignPub, context.blobId)
			assertArrayEquals(ByteArray(size.toInt()) { 65 }, opened.first)

			val plaintext = ByteArray(size.toInt()) { 65 }
			val chunks = sealedBlobChunkCount(size)
			val derivedNonces = case.jsonObject["derivedNonces"]!!.jsonArray.map { it.jsonPrimitive.content }
			val derivedFrames = case.jsonObject["derivedFrames"]!!.jsonArray.map { it.jsonPrimitive.content }
			for (index in 0 until chunks) {
				val slice = plaintext.copyOfRange(
					(index * Protocol.BLOB_CHUNK_BYTES).toInt(),
					minOf(size, (index + 1) * Protocol.BLOB_CHUNK_BYTES).toInt(),
				)
				val final = index + 1 == chunks
				val fixed = ByteArray(BLOB_NONCE_BYTES) { (index + 1).toByte() }
				assertArrayEquals(frames[index.toInt()], sealBlobChunk(slice, key, context, index, final, fixed))
				assertEquals(derivedNonces[index.toInt()], Base64.getEncoder().encodeToString(blobChunkNonce(key, context, index, final)))
				assertEquals(derivedFrames[index.toInt()], Base64.getEncoder().encodeToString(sealBlobChunk(slice, key, context, index, final)))
			}
		}
	}
}
