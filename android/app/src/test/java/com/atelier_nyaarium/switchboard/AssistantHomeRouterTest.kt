package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantHomePutResult
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AssistantHomeRouterTest {
	@Test
	fun aRemoveSendsExplicitNullsAndAnUnreadableAnswerIsNoAnswer() = runBlocking {
		val posted = mutableListOf<JsonObject>()
		var answer: JsonElement? = null
		val router = OwnerOpHomeRouter(signAndPost = { posted += it; answer }, sealing = { null })

		answer = wireJson.encodeToJsonElement(
			AssistantHomePutResult.serializer(),
			AssistantHomePutResult("applied", AssistantHomeRecord(4L)),
		)
		assertEquals(HomePut.Applied(AssistantHomeRecord(4L)), router.put(3L, null, null))
		assertEquals(
			buildJsonObject {
				put("kind", Protocol.Wire.OWNER_OP_ASSISTANT_HOME_PUT)
				put("baseVersion", 3L)
				put("gatewayId", JsonNull)
				put("sealed", JsonNull)
			},
			posted.single(),
		)

		answer = JsonPrimitive("not a record")
		assertNull(router.read())
		assertEquals(Protocol.Wire.OWNER_OP_ASSISTANT_HOME_READ, (posted.last()["kind"] as JsonPrimitive).content)
	}

	@Test
	fun theIntakesOwnAnswerIsNeverAHome() = runBlocking {
		var answer: JsonElement? = null
		val router = OwnerOpHomeRouter(signAndPost = { answer }, sealing = { null })
		val opKey = buildJsonObject { put("conversationId", "c"); put("opId", "o") }

		answer = buildJsonObject { put("opKey", opKey); put("outcome", "refused"); put("reason", "stale") }
		assertNull(router.read())
		assertEquals(HomePut.Refused("stale"), router.put(1L, null, null))

		answer = buildJsonObject { put("opKey", opKey); put("outcome", "durability_uncertain") }
		assertEquals(HomePut.Uncertain("durability_uncertain"), router.put(1L, null, null))

		answer = null
		assertEquals(HomePut.Uncertain(null), router.put(1L, null, null))
	}
}
