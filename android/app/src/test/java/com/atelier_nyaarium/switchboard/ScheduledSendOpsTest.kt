package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ScheduledRecord
import com.atelier_nyaarium.switchboard.proto.ScheduledResultRow
import com.atelier_nyaarium.switchboard.proto.ScheduledSender
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduledSendOpsTest {
	private val team = "domain.gateway.spawn.session"
	private val target = ScheduledTarget("domain", "gateway", "spawn.session")
	private val envelope = ContentEnvelope(1, 1, "AA==", "AA==")

	private class Fake : ScheduledSendOpsCollaborators {
		val posted = mutableListOf<JsonObject>()
		val uploaded = mutableListOf<String>()
		val drafts = mutableListOf<Pair<String, List<MessageFile>>>()
		val appended = mutableListOf<Message>()
		val deleted = mutableListOf<String>()
		var answers: (String) -> JsonElement? = { buildJsonObject { put("outcome", "accepted"); put("version", 4) } }
		var plaintext: ByteArray? = null
		override fun admitPicked(uris: List<Uri>, bucket: String) = emptyList<OutgoingFile>() to null
		override fun fromCanonical(team: String) = team
		override fun scheduleAttachmentDelete(srcs: List<String>) { deleted += srcs }
		override fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) { drafts += text to files }
		override fun append(team: String, message: Message): Long { appended += message; return appended.size.toLong() }
		override suspend fun postOwnerOp(op: JsonObject, opId: String): JsonElement? {
			posted += op
			return answers(op["kind"]!!.jsonPrimitive.content)
		}
		override fun sealScheduledBody(plaintext: ByteArray, opId: String) = ContentEnvelope(1, 1, "AA==", "AA==")
		override fun openScheduledBody(body: ContentEnvelope, opId: String): ByteArray? = plaintext
		override fun targetOf(team: String) = ScheduledTarget("domain", "gateway", "spawn.session")
		override fun teamOf(target: ScheduledTarget) = "domain.gateway.spawn.session"
		override suspend fun uploadFile(file: MessageFile): String { uploaded += file.name; return "sha256-${file.name}" }
		override suspend fun fetchFile(file: MessageFile, bucket: String): MessageFile? = file.copy(src = "/tmp/$bucket/${file.name}")
	}

	private fun record(
		opId: String = "op",
		files: List<MessageFile> = emptyList(),
		routerVersion: Long? = null,
		fireAt: Long = System.currentTimeMillis() + 60_000,
	) = ScheduledSend("text", files, fireAt, opId, null, 1, routerVersion)

	private fun world(vararg records: ScheduledSend): Triple<MutableStateFlow<ChatState>, Fake, ScheduledSendOps> {
		val state = MutableStateFlow(ChatState(scheduledSends = records.associateBy { team }))
		val fake = Fake()
		val ops = ScheduledSendOps(state, ChatPersistence(testStore()), File("/tmp/scheduled"), CoroutineScope(Dispatchers.Unconfined), fake)
		return Triple(state, fake, ops)
	}

	private val JsonObject.kind get() = this["kind"]!!.jsonPrimitive.content

	@Test
	fun aPendingRecordUploadsItsFilesThenPostsAndBecomesAccepted() = runBlocking {
		val file = MessageFile("a.png", "image/png", src = "/tmp/a.png")
		val (state, fake, ops) = world(record(files = listOf(file)))
		ops.drainPending()
		assertEquals(listOf("a.png"), fake.uploaded)
		val post = fake.posted.single()
		assertEquals(Protocol.Wire.OWNER_OP_SCHEDULE_SEND, post.kind)
		assertEquals("op", post["opId"]!!.jsonPrimitive.content)
		assertEquals(listOf("sha256-a.png"), post["files"]!!.jsonArray.map { it.jsonPrimitive.content })
		val held = state.value.scheduledSends.getValue(team)
		assertEquals(4L, held.routerVersion)
		assertEquals("sha256-a.png", held.fileRefs.single().blobId)
	}

	@Test
	fun aRefusedPostHandsTheTextBackIntoTheDraft() = runBlocking {
		val (state, fake, ops) = world(record())
		fake.answers = { buildJsonObject { put("outcome", Protocol.Wire.SocketFrame.REFUSED); put("reason", "spawn point") } }
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals("text", fake.drafts.single().first)
		assertTrue(state.value.error!!.contains("spawn point"))
	}

	@Test
	fun noAnswerLeavesItPendingAndTheNextDrainPostsTheSameOpAgain() = runBlocking {
		val (state, fake, ops) = world(record())
		fake.answers = { null }
		ops.drainPending()
		assertNull(state.value.scheduledSends.getValue(team).routerVersion)
		fake.answers = { buildJsonObject { put("outcome", "accepted"); put("version", 7) } }
		ops.drainPending()
		assertEquals(listOf("op", "op"), fake.posted.map { it["opId"]!!.jsonPrimitive.content })
		assertEquals(7L, state.value.scheduledSends.getValue(team).routerVersion)
	}

	@Test
	fun reschedulingAnAcceptedRecordPostsANewOpThatNamesTheVersionItReplaces() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4))
		val later = System.currentTimeMillis() + 120_000
		ops.rescheduleNow(team, later)
		assertNull(state.value.scheduledSends.getValue(team).routerVersion)
		ops.drainPending()
		val post = fake.posted.single()
		assertTrue(post["opId"]!!.jsonPrimitive.content != "op")
		assertEquals(4L, post["expectedVersion"]!!.jsonPrimitive.content.toLong())
		assertEquals(later, post["fireAt"]!!.jsonPrimitive.content.toLong())
	}

	@Test
	fun cancellingAnAcceptedRecordIsAnIntentUntilTheRouterAccepts() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4, files = listOf(MessageFile("a.png", "image/png", src = "/tmp/a.png"))))
		fake.answers = { null }
		ops.cancelNow(team, edit = false)
		val waiting = state.value.scheduledSends.getValue(team)
		assertTrue(waiting.cancelRequested)
		assertEquals(Protocol.Wire.OWNER_OP_SCHEDULE_CANCEL, fake.posted.single().kind)
		assertEquals(4L, fake.posted.single()["expectedVersion"]!!.jsonPrimitive.content.toLong())

		fake.answers = { buildJsonObject { put("outcome", "accepted"); put("version", 5) } }
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals(listOf("/tmp/a.png"), fake.deleted)
	}

	@Test
	fun cancellingForEditKeepsTheDraftsFilesWhenTheCancelLands() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4, files = listOf(MessageFile("a.png", "image/png", src = "/tmp/a.png"))))
		ops.cancelNow(team, edit = true)
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals("text", fake.drafts.single().first)
		assertTrue(fake.deleted.isEmpty())
	}

	@Test
	fun aCancelTheRouterCallsSettledLeavesTheRecordWaitingForItsSentResult() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4))
		fake.answers = { buildJsonObject { put("outcome", Protocol.Wire.SocketFrame.REFUSED); put("reason", "settled") } }
		ops.cancelNow(team, edit = false)
		val held = state.value.scheduledSends.getValue(team)
		assertEquals(4L, held.routerVersion)
		assertTrue(!held.cancelRequested)
	}

	@Test
	fun aSentResultEchoesTheMessageAndClearsTheRecord() = runBlocking {
		val file = MessageFile("a.png", "image/png", src = "/tmp/a.png", blobId = "sha256-a")
		val (state, fake, ops) = world(record(routerVersion = 4, files = listOf(file)))
		ops.applyRouterResult(ScheduledResultRow("op", "sent", 9, envelope))
		val echo = fake.appended.single()
		assertEquals("op", echo.opId)
		assertEquals(listOf(file), echo.files)
		assertTrue(echo.fromMe)
		assertTrue(state.value.scheduledSends.isEmpty())
	}

	@Test
	fun aFailedResultClearsTheRecordAndReportsIt() = runBlocking {
		val (state, _, ops) = world(record(routerVersion = 4))
		val failed = mutableListOf<String>()
		ops.onScheduledSendFailed = { _, opId -> failed += opId }
		ops.applyRouterResult(ScheduledResultRow("op", "failed", null, envelope))
		assertEquals(listOf("op"), failed)
		assertTrue(state.value.scheduledSends.isEmpty())
	}

	@Test
	fun schedulingOverAnAcceptedRecordNamesTheVersionItReplaces() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4))
		assertTrue(ops.scheduleSend(team, "newer", emptyList(), System.currentTimeMillis() + 90_000))
		ops.drainPending()
		val post = fake.posted.first { it.kind == Protocol.Wire.OWNER_OP_SCHEDULE_SEND }
		assertEquals(4L, post["expectedVersion"]!!.jsonPrimitive.content.toLong())
		assertEquals("newer", state.value.scheduledSends.getValue(team).text)
	}

	@Test
	fun aReplacementTheRouterCallsConflictAdoptsTheRecordItStillHolds() = runBlocking {
		val (state, fake, ops) = world(record(opId = "new").copy(replacesVersion = 4))
		val held = ScheduledRecord(target, 555L, 100L, "old", ScheduledSender("conv", "device"), emptyList(), envelope, "armed", 0, 4)
		fake.answers = { kind ->
			when (kind) {
				Protocol.Wire.OWNER_OP_SCHEDULE_SEND -> buildJsonObject { put("outcome", "conflict"); put("version", 4) }
				Protocol.Wire.OWNER_OP_SCHEDULE_LIST -> JsonArray(listOf(wireJson.encodeToJsonElement(ScheduledRecord.serializer(), held)))
				else -> null
			}
		}
		fake.plaintext = """{"text":"old text","messageId":"old","files":[]}""".toByteArray()
		ops.drainPending()
		val adopted = state.value.scheduledSends.getValue(team)
		assertEquals("old", adopted.opId)
		assertEquals(4L, adopted.routerVersion)
		assertEquals(555L, adopted.fireAtMillis)
		assertTrue(fake.drafts.isEmpty())
	}

	@Test
	fun anAcceptedAnswerForARecordAlreadyFiredEchoesItAndClears() = runBlocking {
		val (state, fake, ops) = world(record())
		fake.answers = { buildJsonObject { put("outcome", "accepted"); put("state", "fired"); put("version", 4) } }
		ops.drainPending()
		assertEquals("op", fake.appended.single().opId)
		assertTrue(state.value.scheduledSends.isEmpty())
	}

	@Test
	fun anAcceptedAnswerAlreadyCancelledElsewhereHandsTheTextBackAndSaysSo() = runBlocking {
		val (state, fake, ops) = world(record())
		fake.answers = { buildJsonObject { put("outcome", "accepted"); put("state", "cancelled"); put("version", 4) } }
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals("text", fake.drafts.single().first)
		assertTrue(state.value.error!!.contains("cancelled"))
	}

	@Test
	fun editingAnAdoptedRecordFetchesItsRouterOnlyFilesBackIntoTheDraft() = runBlocking {
		val routerOnly = MessageFile("a.png", "image/png", src = null, blobId = "sha256-a")
		val (state, fake, ops) = world(record(routerVersion = 4, files = listOf(routerOnly)))
		fake.answers = { null }
		ops.cancelNow(team, edit = true)
		val draft = fake.drafts.single().second.single()
		assertEquals("sha256-a", draft.blobId)
		assertEquals("/tmp/sched-op/a.png", draft.src)
		assertTrue(state.value.scheduledSends.getValue(team).cancelRequested)
	}

	@Test
	fun aPendingResultForARecordThisPhoneDoesNotHoldMirrorsItFromTheRouter() = runBlocking {
		val (state, fake, ops) = world()
		val wire = ScheduledRecord(target, 123_456L, 100L, "op9", ScheduledSender("conv", "device"), listOf("sha256-a"), envelope, "pending", 0, 11)
		fake.answers = { kind ->
			if (kind == Protocol.Wire.OWNER_OP_SCHEDULE_LIST) JsonArray(listOf(wireJson.encodeToJsonElement(ScheduledRecord.serializer(), wire))) else null
		}
		fake.plaintext = """{"text":"later","messageId":"op9","files":[{"name":"a.png","mime":"image/png"}]}""".toByteArray()
		ops.applyRouterResult(ScheduledResultRow("op9", "pending", null, envelope))
		val mirrored = state.value.scheduledSends.getValue(team)
		assertEquals("later", mirrored.text)
		assertEquals(11L, mirrored.routerVersion)
		assertEquals(123_456L, mirrored.fireAtMillis)
		assertEquals("sha256-a", mirrored.fileRefs.single().blobId)
		assertNull(mirrored.fileRefs.single().src)
	}
}
