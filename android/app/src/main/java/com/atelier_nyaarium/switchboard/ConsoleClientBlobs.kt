package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.BLOB_CIPHERTEXT_CHUNK_BYTES
import com.atelier_nyaarium.switchboard.crypto.BlobSealContext
import com.atelier_nyaarium.switchboard.crypto.SealedBlobRange
import com.atelier_nyaarium.switchboard.crypto.openSealedBlobRange
import com.atelier_nyaarium.switchboard.crypto.sealBlobChunk
import com.atelier_nyaarium.switchboard.crypto.sealedBlobChunkCount
import com.atelier_nyaarium.switchboard.crypto.sealedBlobSize
import com.atelier_nyaarium.switchboard.proto.*
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

private suspend fun ConsoleClient.blobAnswer(op: JsonObject, opId: String): JsonObject {
	val answer = postSigned(op, opId) ?: error("blob operation timed out")
	return answer.jsonObject
}

/** Deterministic chunk sealing. */
suspend fun ConsoleClient.uploadSealedBlob(source: File): String {
	val blobId = blobs.ingestFile(source)
	val epoch = boot.contentKeyring.epochs().maxOrNull() ?: error("No content key")
	val key = boot.contentKeyring.keyFor(epoch) ?: error("Missing content key")
	val context = BlobSealContext(boot.domainId, boot.ownerSignPub, epoch, blobId)
	val plainSize = blobs.stat(blobId).have
	val chunks = sealedBlobChunkCount(plainSize)
	val frame = { index: Long ->
		val offset = index * Protocol.BLOB_CHUNK_BYTES
		val bytes = if (plainSize == 0L) ByteArray(0) else blobs.read(blobId, offset, Protocol.BLOB_CHUNK_BYTES).bytes
		sealBlobChunk(bytes, key, context, index, index + 1 == chunks)
	}
	val digest = MessageDigest.getInstance("SHA-256")
	for (index in 0 until chunks) digest.update(frame(index))
	val ciphertextDigest = "sha256-" + digest.digest().joinToString("") { "%02x".format(it) }
	val ciphertextSize = sealedBlobSize(plainSize)
	val status = wireJson.decodeFromJsonElement<BlobUploadStatusAnswer>(blobAnswer(buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_BLOB_UPLOAD_STATUS)
		put("blobId", blobId)
	}, "blob-status:$blobId"))
	// Staging leaves only for bytes this phone can open again.
	val openable = status.epoch?.let { boot.contentKeyring.keyFor(it.toInt()) } != null
	if (status.outcome == "complete" && openable) {
		blobs.remove(blobId)
		return blobId
	}
	if (status.outcome != "absent" && status.outcome != "staged" && status.outcome != "complete") error("blob status refused")
	val begin = wireJson.decodeFromJsonElement<BlobBeginAnswer>(blobAnswer(buildJsonObject {
		put("kind", Protocol.Wire.OWNER_OP_BLOB_BEGIN)
		put("blobId", blobId)
		put("size", plainSize)
		put("ciphertextSize", ciphertextSize)
		put("ciphertextDigest", ciphertextDigest)
		put("epoch", epoch)
	}, "blob-begin:$blobId"))
	if (begin.outcome == "complete") {
		if (openable) blobs.remove(blobId)
		return blobId
	}
	if (begin.outcome != "lease") error(begin.reason ?: "blob begin refused")
	val lease = begin.lease ?: error("blob begin returned no lease")
	var have = begin.have ?: 0L
	while (have < ciphertextSize) {
		val index = have / BLOB_CIPHERTEXT_CHUNK_BYTES
		if (index >= chunks) error("blob cursor exceeds frames")
		val offset = index * BLOB_CIPHERTEXT_CHUNK_BYTES
		val sealed = frame(index)
		val chunk = wireJson.decodeFromJsonElement<BlobChunkAnswer>(blobAnswer(buildJsonObject {
			put("kind", Protocol.Wire.OWNER_OP_BLOB_CHUNK)
			put("blobId", blobId)
			put("lease", wireJson.encodeToJsonElement(BlobLease.serializer(), lease))
			put("offset", offset)
			put("bytes", Base64.getEncoder().encodeToString(sealed))
			put("final", index + 1 == chunks)
		}, "blob-chunk:$blobId:$offset"))
		if (chunk.outcome != "accepted") error(chunk.reason ?: "blob chunk refused")
		if (chunk.complete == true) {
			blobs.remove(blobId)
			return blobId
		}
		val next = chunk.have ?: error("blob chunk returned no cursor")
		if (next <= have) error("blob $blobId stalled at offset $have")
		have = next
	}
	error("blob $blobId was not completed")
}

fun ConsoleClient.blobIdOf(source: File): String = blobs.ingestFile(source)

fun ConsoleClient.forgetBlob(blobId: String) { runCatching { blobs.remove(blobId) } }

fun ConsoleClient.pruneStaleBlobs(maxAgeMs: Long): Long = runCatching { blobs.pruneStale(maxAgeMs) }.getOrDefault(0L)

class BlobAbsent(blobId: String) : Exception("blob $blobId exists on no machine")

suspend fun ConsoleClient.downloadBlob(blobId: String): File {
	blobs.path(blobId)?.let { return it }
	var offset = blobs.stat(blobId).have
	while (true) {
		val answer = wireJson.decodeFromJsonElement<BlobFetchAnswer>(blobAnswer(buildJsonObject {
			put("kind", Protocol.Wire.OWNER_OP_BLOB_FETCH)
			put("blobId", blobId)
			put("range", wireJson.encodeToJsonElement(BlobRange.serializer(), BlobRange(offset, Protocol.BLOB_CHUNK_BYTES.toLong())))
		}, "blob-fetch:$blobId:$offset"))
		if (answer.outcome == "absent") throw BlobAbsent(blobId)
		if (answer.outcome != "fetched") error("blob fetch refused")
		val bytes = Base64.getDecoder().decode(answer.bytes ?: error("blob fetch returned no bytes"))
		val epoch = answer.epoch?.toInt() ?: error("blob fetch returned no epoch")
		val size = answer.size ?: error("blob fetch returned no size")
		val returnedOffset = answer.offset ?: error("blob fetch returned no offset")
		val key = boot.contentKeyring.keyFor(epoch) ?: error("Missing content key")
		val opened = openSealedBlobRange(SealedBlobRange(bytes, returnedOffset, size, epoch), offset, Protocol.BLOB_CHUNK_BYTES.toLong(), key, BlobSealContext(boot.domainId, boot.ownerSignPub, epoch, blobId))
		val written = blobs.write(blobId, offset, opened.first, opened.second)
		if (opened.second) return blobs.path(blobId) ?: error("blob $blobId was not stored")
		if (written.have <= offset) error("blob $blobId stalled at offset $offset")
		offset = written.have
	}
}
