package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ScheduledRecord
import com.atelier_nyaarium.switchboard.proto.ScheduledResultRow
import com.atelier_nyaarium.switchboard.proto.ScheduledSender
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
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
		val appendedTeams = mutableListOf<String>()
		val deleted = mutableListOf<String>()
		var answers: (String) -> JsonElement? = { buildJsonObject { put("outcome", "accepted"); put("version", 4) } }
		var plaintext: ByteArray? = null
		var fetchHold: TestHold? = null
		override fun admitFiles(files: List<MessageFile>) = emptyList<OutgoingFile>() to null
		override fun fromCanonical(team: String) = team
		override fun scheduleAttachmentDelete(srcs: List<String>) { deleted += srcs }
		override fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) { drafts += text to files }
		var appendInto: ((String, Message) -> Unit)? = null
		override fun append(team: String, message: Message): Long {
			appendedTeams += team
			appended += message
			appendInto?.invoke(team, message)
			return appended.size.toLong()
		}
		override suspend fun postOwnerOp(op: JsonObject, opId: String): JsonElement? {
			posted += op
			return answers(op["kind"]!!.jsonPrimitive.content)
		}
		override fun sealScheduledBody(plaintext: ByteArray, opId: String) = ContentEnvelope(1, 1, "AA==", "AA==")
		override fun openScheduledBody(body: ContentEnvelope, opId: String): ByteArray? = plaintext
		override fun targetOf(team: String) = ScheduledTarget("domain", "gateway", "spawn.session")
		override fun teamOf(target: ScheduledTarget) = "domain.gateway.spawn.session"
		override suspend fun uploadFile(file: MessageFile): String { uploaded += file.name; return "sha256-${file.name}" }
		override suspend fun fetchFile(file: MessageFile, bucket: String): MessageFile? {
			fetchHold?.pass()
			return file.copy(src = "/tmp/$bucket/${file.name}")
		}
	}

	private fun record(
		opId: String = "op",
		files: List<MessageFile> = emptyList(),
		routerVersion: Long? = null,
		fireAt: Long = System.currentTimeMillis() + 60_000,
	) = ScheduledSend("text", files, fireAt, opId, null, 1, routerVersion)

	private val provision = ProvisionFence()

	private fun world(
		vararg records: ScheduledSend,
		threads: Map<String, List<Message>> = emptyMap(),
	): Triple<MutableStateFlow<ChatState>, Fake, ScheduledSendOps> {
		val state = MutableStateFlow(ChatState(scheduledSends = records.associateBy { team }, threads = threads))
		val fake = Fake()
		val ops = ScheduledSendOps(state, ChatPersistence(testStore()) { state.value }, File("/tmp/scheduled"), CoroutineScope(Dispatchers.Unconfined), fake, provision)
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
		assertEquals(team, state.value.notices.single().team)
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
	fun aCancelOverAFinishedSendSaysHowItFinishedKeyedToTheSend() = runBlocking {
		for ((settled, said) in listOf(null to Line.ALREADY_SENT, "fired" to Line.ALREADY_SENT, "cancelled" to Line.ALREADY_CANCELLED, "error" to Line.ALREADY_FAILED)) {
			val (state, fake, ops) = world(record(routerVersion = 4))
			fake.answers = {
				buildJsonObject {
					put("outcome", Protocol.Wire.SocketFrame.REFUSED)
					put("reason", "settled")
					settled?.let { put("state", it) }
				}
			}
			ops.cancelNow(team, edit = false)
			assertTrue(state.value.scheduledSends.isEmpty())
			assertEquals(said.text, state.value.notices.single().text)
			assertEquals(scheduledNoticeKey(team), state.value.notices.single().key)
		}
	}

	@Test
	fun aCancelAtTheMomentOfFiringKeepsTheSendWaitingForItsResult() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4))
		fake.answers = { buildJsonObject { put("outcome", "conflict") } }
		ops.cancelNow(team, edit = false)
		assertTrue(!state.value.scheduledSends.getValue(team).cancelRequested)
		assertEquals(Line.SENDING_NOW.text, state.value.notices.single().text)
	}

	@Test
	fun aRescheduleOverAFiredSendSaysAlreadySentAndLetsTheSentResultEchoIt() = runBlocking {
		val (state, fake, ops) = world(record().copy(replacesVersion = 4))
		fake.answers = { buildJsonObject { put("outcome", "refused"); put("reason", "settled"); put("state", "fired") } }
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertTrue(fake.drafts.isEmpty())
		assertEquals(Line.ALREADY_SENT.text, state.value.notices.single().text)
	}

	@Test
	fun aCancelThatCannotReachTheRouterIsToldAndALaterAnswerClearsIt() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4))
		fake.answers = { throw java.io.IOException("down") }
		ops.cancelNow(team, edit = false)
		assertTrue(state.value.scheduledSends.getValue(team).cancelRequested)
		assertEquals(scheduledNoticeKey(team), state.value.notices.single().key)

		fake.answers = { buildJsonObject { put("outcome", "accepted") } }
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertTrue(state.value.notices.isEmpty())
	}

	@Test
	fun moreFilesThanASendCarriesAreRefusedBeforeTheyPost() = runBlocking {
		val (state, fake, ops) = world()
		val files = (0..Protocol.CHANNEL_FILES_MAX).map { MessageFile("f$it.png", "image/png", src = "/tmp/f$it.png") }
		val now = System.currentTimeMillis()

		assertTrue(!ops.scheduleSend(team, "text", files, now + 90_000))
		assertTrue(fake.posted.isEmpty())
		assertEquals(team, state.value.notices.single().team)
		assertEquals(scheduleFilesLine(Protocol.CHANNEL_FILES_MAX), scheduleBlocker(now + 90_000, now, files.size))
		assertEquals(null, scheduleBlocker(now + 90_000, now, Protocol.CHANNEL_FILES_MAX))
		assertEquals(Line.PICK_LATER.text, scheduleBlocker(now + 30_000, now, 0))
	}

	@Test
	fun aDockPastItsTimeReadsAsSendingAndOffersNoEdit() {
		val rec = record(routerVersion = 4)
		val zone = java.time.ZoneOffset.UTC
		assertTrue(scheduledDockText(rec, rec.fireAtMillis - 1, zone).acts)
		val past = scheduledDockText(rec, rec.fireAtMillis, zone)
		assertEquals("Sending", past.headline)
		assertTrue(!past.acts)
	}

	@Test
	fun aSentResultEchoesTheMessageAndClearsTheRecord() = runBlocking {
		val file = MessageFile("a.png", "image/png", src = "/tmp/a.png", blobId = "sha256-a")
		val held = record(routerVersion = 4, files = listOf(file))
		val (state, fake, ops) = world(held)
		ops.applyRouterResult(ScheduledResultRow("op", "sent", 9, body = envelope), ReadAnchor(1, 1, 1))
		val echo = fake.appended.single()
		assertEquals("op", echo.opId)
		assertEquals(held.fireAtMillis, echo.at)
		assertEquals(listOf(file), echo.files)
		assertTrue(echo.fromMe)
		assertTrue(state.value.scheduledSends.isEmpty())
	}

	@Test
	fun aFailedResultForAHeldSendLandsAsANotDeliveredMessage() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4))
		val failed = mutableListOf<String>()
		val position = ReadAnchor(3, 8, 900)
		ops.onScheduledSendFailed = { _, opId -> failed += opId }
		ops.applyRouterResult(ScheduledResultRow("op", "failed", null, "target_mismatch", envelope), position)
		assertEquals(listOf("op"), failed)
		assertTrue(state.value.scheduledSends.isEmpty())
		assertTrue(fake.drafts.isEmpty())
		val row = fake.appended.single()
		assertEquals("error", row.status)
		assertEquals(reasonSentence(Act.SENDING_SCHEDULED, "target_mismatch"), row.failReason)
		assertEquals(position, ops.takeFailurePosition("op"))
	}

	@Test
	fun aFailedResultForAnEchoedSendMarksTheMessageWithItsReason() = runBlocking {
		val echo = Message(true, "text", 1, opId = "op")
		val (state, fake, ops) = world(threads = mapOf(team to listOf(echo)))
		ops.applyRouterResult(ScheduledResultRow("op", "failed", null, "target_mismatch", envelope), ReadAnchor(3, 8, 900))
		val row = state.value.threads.getValue(team).single()
		assertEquals("error", row.status)
		assertEquals(reasonSentence(Act.SENDING_SCHEDULED, "target_mismatch"), row.failReason)
		assertTrue(row.opId != "op")
		assertTrue(fake.drafts.isEmpty())
		assertTrue(state.value.notices.isEmpty())
	}

	@Test
	fun theSameFailedResultTwiceMarksOnce() = runBlocking {
		val echo = Message(true, "text", 1, opId = "op")
		val (state, _, ops) = world(threads = mapOf(team to listOf(echo)))
		val failed = mutableListOf<String>()
		ops.onScheduledSendFailed = { _, opId -> failed += opId }
		val row = ScheduledResultRow("op", "failed", null, "delivery_failed", envelope)
		ops.applyRouterResult(row, ReadAnchor(3, 8, 900))
		val marked = state.value.threads.getValue(team).single()
		ops.applyRouterResult(row, ReadAnchor(3, 8, 900))
		assertEquals(marked, state.value.threads.getValue(team).single())
		assertEquals(listOf("op"), failed)
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
		val held = ScheduledRecord(target, 555L, 100L, "old", ScheduledSender("conv", "device"), emptyList(), envelope, "armed", attempts = 0, version = 4)
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
	fun aFreshConflictAdoptsTheArmedRecordAndReturnsTheLocalTextToTheDraft() = runBlocking {
		val (state, fake, ops) = world(record())
		val held = ScheduledRecord(target, 555L, 100L, "old", ScheduledSender("conv", "device"), emptyList(), envelope, "armed", attempts = 0, version = 4)
		fake.answers = { kind ->
			when (kind) {
				Protocol.Wire.OWNER_OP_SCHEDULE_SEND -> buildJsonObject { put("outcome", "conflict") }
				Protocol.Wire.OWNER_OP_SCHEDULE_LIST -> JsonArray(listOf(wireJson.encodeToJsonElement(ScheduledRecord.serializer(), held)))
				else -> null
			}
		}
		fake.plaintext = """{"text":"old text","messageId":"old","files":[]}""".toByteArray()
		ops.drainPending()
		assertEquals("old", state.value.scheduledSends.getValue(team).opId)
		assertEquals("text", fake.drafts.single().first)
		assertEquals(team, state.value.notices.single().team)
	}

	@Test
	fun aFreshConflictWithNoArmedRecordRemovesTheRecordAndReturnsTheTextToTheDraft() = runBlocking {
		val (state, fake, ops) = world(record())
		fake.answers = { kind ->
			when (kind) {
				Protocol.Wire.OWNER_OP_SCHEDULE_SEND -> buildJsonObject { put("outcome", "conflict") }
				Protocol.Wire.OWNER_OP_SCHEDULE_LIST -> JsonArray(emptyList())
				else -> null
			}
		}
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals("text", fake.drafts.single().first)
		assertEquals(team, state.value.notices.single().team)
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
		assertEquals(team, state.value.notices.single().team)
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
	fun aTakeBackStillFetchingAtAReprovisionWritesNothingForTheNextOwner() = runBlocking {
		val routerOnly = MessageFile("a.png", "image/png", src = null, blobId = "sha256-a")
		val (state, fake, ops) = world(record(routerVersion = 4, files = listOf(routerOnly)))
		val hold = TestHold().also { fake.fetchHold = it }
		fake.answers = { buildJsonObject { put("outcome", "refused"); put("reason", "settled") } }

		val cancelling = async { ops.cancelNow(team, edit = true) }
		hold.entered.await()
		provision.reprovision { state.value = ChatState() }
		hold.release()
		cancelling.await()

		assertEquals(emptyList<Pair<String, List<MessageFile>>>(), fake.drafts)
		assertEquals(emptyMap<String, ScheduledSend>(), state.value.scheduledSends)
	}

	@Test
	fun aPendingResultForARecordThisPhoneDoesNotHoldMirrorsItFromTheRouter() = runBlocking {
		val (state, fake, ops) = world()
		val wire = ScheduledRecord(target, 123_456L, 100L, "op9", ScheduledSender("conv", "device"), listOf("sha256-a"), envelope, "armed", attempts = 0, version = 11)
		fake.answers = { kind ->
			if (kind == Protocol.Wire.OWNER_OP_SCHEDULE_LIST) JsonArray(listOf(wireJson.encodeToJsonElement(ScheduledRecord.serializer(), wire))) else null
		}
		fake.plaintext = """{"text":"later","messageId":"op9","files":[{"name":"a.png","mime":"image/png"}]}""".toByteArray()
		ops.applyRouterResult(ScheduledResultRow("op9", "pending", null, body = envelope), ReadAnchor(1, 1, 1))
		val mirrored = state.value.scheduledSends.getValue(team)
		assertEquals("later", mirrored.text)
		assertEquals(11L, mirrored.routerVersion)
		assertEquals(123_456L, mirrored.fireAtMillis)
		assertEquals("sha256-a", mirrored.fileRefs.single().blobId)
		assertNull(mirrored.fileRefs.single().src)
	}

	@Test
	fun aSentResultForARecordThisPhoneDoesNotHoldEchoesTheRouterRecordIntoItsThread() = runBlocking {
		val (_, fake, ops) = world()
		val wire = ScheduledRecord(target, 123_456L, 100L, "op9", ScheduledSender("conv", "device"), listOf("sha256-a"), envelope, "fired", attempts = 0, version = 11)
		fake.answers = { kind ->
			if (kind == Protocol.Wire.OWNER_OP_SCHEDULE_LIST) JsonArray(listOf(wireJson.encodeToJsonElement(ScheduledRecord.serializer(), wire))) else null
		}
		fake.plaintext = """{"text":"later","messageId":"op9","files":[{"name":"a.png","mime":"image/png"}]}""".toByteArray()
		ops.applyRouterResult(ScheduledResultRow("op9", "sent", null, body = envelope), ReadAnchor(1, 1, 1))
		assertEquals(listOf(team), fake.appendedTeams)
		assertEquals("op9", fake.appended.single().opId)
		assertEquals(123_456L, fake.appended.single().at)
		assertEquals("sha256-a", fake.appended.single().files.single().blobId)
	}

	@Test
	fun aRepeatedSentResultForAnExistingThreadMessageIsIgnored() = runBlocking {
		val existing = Message(true, "later", 1L, opId = "op9")
		val (_, fake, ops) = world(threads = mapOf(team to listOf(existing)))
		val wire = ScheduledRecord(target, 123_456L, 100L, "op9", ScheduledSender("conv", "device"), emptyList(), envelope, "armed", attempts = 0, version = 11)
		fake.answers = { kind ->
			if (kind == Protocol.Wire.OWNER_OP_SCHEDULE_LIST) JsonArray(listOf(wireJson.encodeToJsonElement(ScheduledRecord.serializer(), wire))) else null
		}
		ops.applyRouterResult(ScheduledResultRow("op9", "sent", null, body = envelope), ReadAnchor(1, 1, 1))
		assertTrue(fake.appended.isEmpty())
	}

	private fun routerRecord(state: String, reason: String? = null, fireAt: Long = 555L) =
		ScheduledRecord(target, fireAt, 100L, "op", ScheduledSender("conv", "device"), emptyList(), envelope, state, reason = reason, attempts = 0, version = 4)

	private fun listing(vararg records: ScheduledRecord): (String) -> JsonElement? = { kind ->
		if (kind == Protocol.Wire.OWNER_OP_SCHEDULE_LIST) JsonArray(records.map { wireJson.encodeToJsonElement(ScheduledRecord.serializer(), it) }) else null
	}

	@Test
	fun theRoutersRecordDecidesHowAHeldSendPastItsTimeEnds() {
		val now = 1_000_000L
		val past = record(routerVersion = 4, fireAt = now - SETTLE_GRACE_MS)
		assertEquals(Settle.Wait, settleFromRouter(past.copy(fireAtMillis = now - 1), routerRecord("error"), now))
		assertEquals(Settle.Wait, settleFromRouter(past.copy(routerVersion = null), routerRecord("error"), now))
		assertEquals(Settle.Wait, settleFromRouter(past.copy(cancelRequested = true), routerRecord("error"), now))
		assertEquals(Settle.Sent, settleFromRouter(past, routerRecord("fired"), now))
		assertEquals(Settle.Failed("malformed_body"), settleFromRouter(past, routerRecord("error", "malformed_body"), now))
		assertEquals(Settle.Cancelled, settleFromRouter(past, routerRecord("cancelled"), now))
		assertEquals(Settle.Wait, settleFromRouter(past, routerRecord("armed"), now))
		assertEquals(Settle.Wait, settleFromRouter(past, routerRecord("firing"), now))
		assertEquals(Settle.Gone, settleFromRouter(past, null, now))
	}

	@Test
	fun aHeldSendPastItsTimeSettlesFromTheRoutersErrorRecordOnItsFirstPass() = runBlocking {
		val firedAt = System.currentTimeMillis() - 60_000
		val (state, fake, ops) = world(record(routerVersion = 4, fireAt = firedAt))
		fake.answers = listing(routerRecord("error", "malformed_body"))
		fake.appendInto = { t, m -> state.value = state.value.copy(threads = state.value.threads + (t to state.value.threads[t].orEmpty() + m)) }
		val failed = mutableListOf<String>()
		ops.onScheduledSendFailed = { _, opId -> failed += opId }

		ops.drainPending()

		assertTrue(state.value.scheduledSends.isEmpty())
		val row = fake.appended.single()
		assertEquals("error", row.status)
		assertEquals(reasonSentence(Act.SENDING_SCHEDULED, "malformed_body"), row.failReason)
		assertEquals(firedAt, row.at)
		assertTrue(fake.drafts.isEmpty())
		assertEquals(listOf("op"), failed)

		ops.applyRouterResult(ScheduledResultRow("op", "sent", null, body = envelope), ReadAnchor(1, 1, 1))
		ops.applyRouterResult(ScheduledResultRow("op", "failed", null, "malformed_body", envelope), ReadAnchor(1, 2, 2))
		assertEquals(1, fake.appended.size)
		assertEquals(listOf("op"), failed)
	}

	@Test
	fun aSendStuckBeforeReasonsExistedSettlesOnItsFirstPassWithTheFallbackSentence() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4, fireAt = System.currentTimeMillis() - 3_600_000))
		fake.answers = listing(routerRecord("error"))
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals(reasonSentence(Act.SENDING_SCHEDULED, null), fake.appended.single().failReason)
	}

	@Test
	fun aRetriedFailureKeepsItsOneSuffix() {
		val marked = withFailedSend(listOf(Message(true, "text", 1, opId = "op")), "op", "why")
		assertEquals(failedSendOpId("op"), marked.single().opId)
		assertEquals(marked, withFailedSend(marked, "op", "why"))
	}

	@Test
	fun aHeldSendTheRouterNoLongerHoldsGoesBackToTheComposer() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4, fireAt = System.currentTimeMillis() - 60_000))
		fake.answers = listing()
		ops.drainPending()
		assertTrue(state.value.scheduledSends.isEmpty())
		assertEquals("text", fake.drafts.single().first)
		assertEquals(handedBack(Line.CHANGED_ELSEWHERE.text), state.value.notices.single().text)
	}

	@Test
	fun aHeldSendStillArmedOrUnreadWaitsAndIsNotAskedAgainAtOnce() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4, fireAt = System.currentTimeMillis() - 60_000))
		fake.answers = listing(routerRecord("armed"))
		ops.drainPending()
		assertEquals(1, fake.posted.size)
		ops.drainPending()
		assertEquals(1, fake.posted.size)
		assertEquals("op", state.value.scheduledSends.getValue(team).opId)
	}

	@Test
	fun anUnreadListingSettlesNothing() = runBlocking {
		val (state, fake, ops) = world(record(routerVersion = 4, fireAt = System.currentTimeMillis() - 60_000))
		fake.answers = { null }
		ops.drainPending()
		assertEquals("op", state.value.scheduledSends.getValue(team).opId)
		assertTrue(fake.drafts.isEmpty())
	}

	private suspend fun settledAfter(ops: ScheduledSendOps, count: Int) =
		kotlinx.coroutines.withTimeout(5_000) { while (ops.resultsApplied.get() < count) kotlinx.coroutines.delay(1) }

	@Test
	fun sentThenFailedRowsAlwaysEndAsOneNotDeliveredMessage() = runBlocking {
		repeat(100) {
			val (state, fake, ops) = world(record(routerVersion = 4))
			fake.appendInto = { t, m -> state.value = state.value.copy(threads = state.value.threads + (t to state.value.threads[t].orEmpty() + m)) }
			ops.onRouterResult(ScheduledResultRow("op", "sent", null, body = envelope), ReadAnchor(1, 1, 1))
			ops.onRouterResult(ScheduledResultRow("op", "failed", null, "delivery_failed", envelope), ReadAnchor(1, 2, 2))
			settledAfter(ops, 2)
			val rows = state.value.threads[team].orEmpty()
			assertEquals(1, rows.size)
			assertEquals("error", rows.single().status)
			assertTrue(fake.drafts.isEmpty())
		}
	}

	private fun orders(rows: List<String>): List<List<String>> =
		if (rows.size <= 1) listOf(rows) else rows.flatMap { first -> orders(rows - first).map { listOf(first) + it } }

	@Test
	fun everyOrderOfOneSchedulesRowsEndsTheSame() = runBlocking {
		// Rows, ended failed
		val cases = listOf(
			listOf("pending", "sent") to false,
			listOf("sent", "failed") to true,
			listOf("pending", "failed") to true,
			listOf("pending", "sent", "failed") to true,
		)
		for (held in listOf(true, false)) for ((rows, failed) in cases) for (order in orders(rows)) {
			val (state, fake, ops) = if (held) world(record(routerVersion = 4)) else world()
			fake.answers = listing(if (failed) routerRecord("error", "delivery_failed") else routerRecord("fired"))
			fake.plaintext = """{"text":"text","messageId":"op","files":[]}""".toByteArray()
			fake.appendInto = { t, m -> state.value = state.value.copy(threads = state.value.threads + (t to state.value.threads[t].orEmpty() + m)) }
			for ((at, outcome) in order.withIndex()) {
				val reason = if (outcome == "failed") "delivery_failed" else null
				ops.applyRouterResult(ScheduledResultRow("op", outcome, null, reason, envelope), ReadAnchor(1, at.toLong(), at.toLong()))
			}
			val label = "held=$held order=$order"
			assertTrue(label, state.value.scheduledSends.isEmpty())
			val message = state.value.threads[team].orEmpty().singleOrNull()
			assertTrue(label, message != null)
			assertEquals(label, if (failed) "error" else null, message!!.status)
			assertEquals(label, if (failed) reasonSentence(Act.SENDING_SCHEDULED, "delivery_failed") else null, message.failReason)
			assertTrue(label, fake.drafts.isEmpty())
		}
	}

	@Test
	fun aLonePendingRowOfASettledSendShowsNothing() = runBlocking {
		for (settled in listOf("fired", "error", "cancelled")) {
			val (state, fake, ops) = world()
			fake.answers = listing(routerRecord(settled))
			fake.plaintext = """{"text":"text","messageId":"op","files":[]}""".toByteArray()
			ops.applyRouterResult(ScheduledResultRow("op", "pending", null, body = envelope), ReadAnchor(1, 1, 1))
			assertTrue(settled, state.value.scheduledSends.isEmpty())
			assertTrue(settled, fake.appended.isEmpty())
		}
	}
}
